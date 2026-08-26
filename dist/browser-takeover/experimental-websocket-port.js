const PORTS = new WeakMap();
export function registerExperimentalWebSocketBrokerPort(broker, port) {
    if (PORTS.has(broker))
        throw new Error("experimental WebSocket broker port already registered");
    PORTS.set(broker, port);
}
export function experimentalWebSocketBrokerPort(broker) {
    const port = PORTS.get(broker);
    if (!port)
        throw new Error("TakeoverBroker experimental WebSocket port is unavailable");
    return port;
}
//# sourceMappingURL=experimental-websocket-port.js.map