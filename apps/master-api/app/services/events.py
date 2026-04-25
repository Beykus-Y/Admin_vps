NOISY_UDP_PROCESSES = {"xray", "sing-box", "hysteria", "hysteria-server", "tuic", "trojan-go"}
EPHEMERAL_UDP_MIN = 32768
EPHEMERAL_UDP_MAX = 60999


def is_noisy_dynamic_udp_port(protocol: str | None, port: int | None, process_name: str | None) -> bool:
    if protocol != "udp" or port is None:
        return False
    if port < EPHEMERAL_UDP_MIN or port > EPHEMERAL_UDP_MAX:
        return False
    return (process_name or "").lower() in NOISY_UDP_PROCESSES


def is_noisy_port_event(event) -> bool:
    if event.type != "port.new_unexpected":
        return False
    extra = event.extra or {}
    return is_noisy_dynamic_udp_port(
        extra.get("protocol"),
        extra.get("port"),
        extra.get("process"),
    )
