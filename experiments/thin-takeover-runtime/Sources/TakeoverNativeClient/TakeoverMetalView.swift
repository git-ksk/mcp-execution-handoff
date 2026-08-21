#if os(iOS)
import CoreVideo
import Metal
import MetalKit
import UIKit

/// iOS presenter for decoded NV12 VideoToolbox frames.
///
/// The decoder writes into a single-slot `LatestDecodedFrameStore`; this view consumes at display
/// cadence and therefore cannot build a presentation FIFO. NV12->RGB stays on GPU through
/// CVMetalTextureCache and a tiny Metal shader.
@MainActor
public final class TakeoverMetalView: MTKView {
    private var textureCache: CVMetalTextureCache?
    private var commandQueue: MTLCommandQueue?
    private var pipeline: MTLRenderPipelineState?
    private var frameStore = LatestDecodedFrameStore()

    public convenience init(frame: CGRect = .zero) {
        self.init(frame: frame, device: MTLCreateSystemDefaultDevice())
    }

    public override init(frame frameRect: CGRect, device: MTLDevice?) {
        super.init(frame: frameRect, device: device)
        configure()
    }

    public required init(coder: NSCoder) {
        super.init(coder: coder)
        if device == nil { device = MTLCreateSystemDefaultDevice() }
        configure()
    }

    /// Binds the single-slot store used by the VideoToolbox decoder callback.
    public func bind(frameStore: LatestDecodedFrameStore) {
        self.frameStore = frameStore
    }

    public func clear() {
        frameStore.clear()
    }

    public override func draw(_ rect: CGRect) {
        guard let commandQueue,
              let pipeline,
              let textureCache,
              let frame = frameStore.takeLatest(),
              CVPixelBufferGetPlaneCount(frame.pixelBuffer) >= 2,
              let descriptor = currentRenderPassDescriptor,
              let drawable = currentDrawable else {
            return
        }
        let pixelBuffer = frame.pixelBuffer
        let yWidth = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
        let yHeight = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
        let uvWidth = CVPixelBufferGetWidthOfPlane(pixelBuffer, 1)
        let uvHeight = CVPixelBufferGetHeightOfPlane(pixelBuffer, 1)

        var yRef: CVMetalTexture?
        var uvRef: CVMetalTexture?
        guard CVMetalTextureCacheCreateTextureFromImage(
            kCFAllocatorDefault, textureCache, pixelBuffer, nil, .r8Unorm,
            yWidth, yHeight, 0, &yRef
        ) == kCVReturnSuccess,
        CVMetalTextureCacheCreateTextureFromImage(
            kCFAllocatorDefault, textureCache, pixelBuffer, nil, .rg8Unorm,
            uvWidth, uvHeight, 1, &uvRef
        ) == kCVReturnSuccess,
        let yRef,
        let uvRef,
        let yTexture = CVMetalTextureGetTexture(yRef),
        let uvTexture = CVMetalTextureGetTexture(uvRef),
        let commandBuffer = commandQueue.makeCommandBuffer(),
        let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor) else {
            return
        }

        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentTexture(yTexture, index: 0)
        encoder.setFragmentTexture(uvTexture, index: 1)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }

    private func configure() {
        framebufferOnly = true
        colorPixelFormat = .bgra8Unorm
        isPaused = false
        enableSetNeedsDisplay = false
        preferredFramesPerSecond = UIScreen.main.maximumFramesPerSecond

        guard let device else { return }
        commandQueue = device.makeCommandQueue()
        var cache: CVMetalTextureCache?
        guard CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, device, nil, &cache) == kCVReturnSuccess else { return }
        textureCache = cache

        do {
            let library = try device.makeLibrary(source: Self.shaderSource, options: nil)
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = library.makeFunction(name: "takeoverVertex")
            descriptor.fragmentFunction = library.makeFunction(name: "takeoverFragment")
            descriptor.colorAttachments[0].pixelFormat = colorPixelFormat
            pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        } catch {
            pipeline = nil
        }
    }

    private static let shaderSource = """
    #include <metal_stdlib>
    using namespace metal;
    struct VertexOut { float4 position [[position]]; float2 uv; };
    vertex VertexOut takeoverVertex(uint vertexID [[vertex_id]]) {
        float2 positions[3] = { float2(-1.0,-1.0), float2(3.0,-1.0), float2(-1.0,3.0) };
        float2 uvs[3] = { float2(0.0,1.0), float2(2.0,1.0), float2(0.0,-1.0) };
        VertexOut out; out.position=float4(positions[vertexID],0.0,1.0); out.uv=uvs[vertexID]; return out;
    }
    fragment float4 takeoverFragment(VertexOut in [[stage_in]],
        texture2d<float> yTexture [[texture(0)]], texture2d<float> uvTexture [[texture(1)]]) {
        constexpr sampler s(address::clamp_to_edge, filter::linear);
        float y=yTexture.sample(s,in.uv).r;
        float2 cbcr=uvTexture.sample(s,in.uv).rg-float2(0.5,0.5);
        y=max(0.0,(y-(16.0/255.0))*(255.0/219.0));
        float r=y+1.5748*cbcr.y;
        float g=y-0.1873*cbcr.x-0.4681*cbcr.y;
        float b=y+1.8556*cbcr.x;
        return float4(saturate(float3(r,g,b)),1.0);
    }
    """
}
#endif
