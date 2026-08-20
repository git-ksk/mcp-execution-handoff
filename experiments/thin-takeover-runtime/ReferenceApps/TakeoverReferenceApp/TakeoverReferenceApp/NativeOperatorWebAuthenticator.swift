import UIKit
import WebKit

@MainActor
final class NativeOperatorWebAuthenticator: UIViewController, WKNavigationDelegate {
    enum AuthError: Error {
        case invalidLocator
        case noApplicableSessionCookie
        case cancelled
    }

    private let origin: URL
    private let authURL: URL
    private let completion: (Result<String, Error>) -> Void
    private let webView: WKWebView
    private var completed = false

    init(locator: URL, completion: @escaping (Result<String, Error>) -> Void) throws {
        guard let scheme = locator.scheme,
              scheme == "https" || scheme == "http",
              let host = locator.host else {
            throw AuthError.invalidLocator
        }
        var originComponents = URLComponents()
        originComponents.scheme = scheme
        originComponents.host = host
        originComponents.port = locator.port
        guard let origin = originComponents.url,
              let authURL = URL(string: "/takeover/operator/native-auth", relativeTo: origin)?.absoluteURL else {
            throw AuthError.invalidLocator
        }

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        self.webView = WKWebView(frame: .zero, configuration: configuration)
        self.origin = origin
        self.authURL = authURL
        self.completion = completion
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Authorize Native Takeover"
        view.backgroundColor = .systemBackground
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .cancel,
            target: self,
            action: #selector(cancelPressed)
        )
        var request = URLRequest(url: authURL)
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        webView.load(request)
    }

    @objc private func cancelPressed() {
        finish(.failure(AuthError.cancelled))
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        guard let response = navigationResponse.response as? HTTPURLResponse,
              response.value(forHTTPHeaderField: "x-takeover-native-authorized") == "1",
              sameOrigin(response.url) else {
            decisionHandler(.allow)
            return
        }

        decisionHandler(.allow)
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            Task { @MainActor [weak self] in
                guard let self, !self.completed else { return }
                let applicable = cookies.filter { self.appliesToTakeoverAPI($0) }
                guard let cookie = HTTPCookie.requestHeaderFields(with: applicable)["Cookie"], !cookie.isEmpty else {
                    self.finish(.failure(AuthError.noApplicableSessionCookie))
                    return
                }
                self.finish(.success(cookie))
            }
        }
    }

    private func sameOrigin(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme?.lowercased() == origin.scheme?.lowercased()
            && url.host?.lowercased() == origin.host?.lowercased()
            && effectivePort(url) == effectivePort(origin)
            && url.path == "/takeover/operator/native-auth"
    }

    private func appliesToTakeoverAPI(_ cookie: HTTPCookie) -> Bool {
        guard let host = origin.host?.lowercased() else { return false }
        let cookieDomain = cookie.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        let domainMatches = host == cookieDomain || host.hasSuffix("." + cookieDomain)
        let pathMatches = "/takeover/api/claim".hasPrefix(cookie.path)
        let secureMatches = origin.scheme?.lowercased() == "https" ? cookie.isSecure : true
        let alive = cookie.expiresDate.map { $0 > Date() } ?? true
        return domainMatches && pathMatches && secureMatches && alive
    }

    private func effectivePort(_ url: URL) -> Int? {
        if let port = url.port { return port }
        switch url.scheme?.lowercased() {
        case "https": return 443
        case "http": return 80
        default: return nil
        }
    }

    private func finish(_ result: Result<String, Error>) {
        guard !completed else { return }
        completed = true
        webView.stopLoading()
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak webView] cookies in
            // Cookie destruction is best-effort after copying the short-lived header into the
            // broker's in-memory URLSession boundary. The data store itself is nonpersistent.
            for cookie in cookies { webView?.configuration.websiteDataStore.httpCookieStore.delete(cookie) }
        }
        dismiss(animated: true) { [completion] in completion(result) }
    }
}
