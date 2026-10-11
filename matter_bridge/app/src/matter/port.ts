import { createSocket } from "node:dgram";
import { createServer } from "node:net";

/** Checks whether a UDP port can be bound (IPv6 if available, otherwise IPv4) */
function udpFree(port: number, type: "udp6" | "udp4"): Promise<boolean | "unsupported"> {
    return new Promise(resolve => {
        const socket = createSocket({ type, reuseAddr: false });
        socket.once("error", (e: NodeJS.ErrnoException) => {
            socket.close();
            resolve(e.code === "EAFNOSUPPORT" || e.code === "EADDRNOTAVAIL" ? "unsupported" : false);
        });
        socket.bind({ port, address: type === "udp6" ? "::" : "0.0.0.0", exclusive: true }, () => {
            socket.close(() => resolve(true));
        });
    });
}

function tcpFree(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.listen({ port, exclusive: true }, () => server.close(() => resolve(true)));
    });
}

export async function portFree(port: number, tcp: boolean) {
    const v6 = await udpFree(port, "udp6");
    if (v6 === false) return false;
    if ((await udpFree(port, "udp4")) === false) return false;
    if (tcp && !(await tcpFree(port))) return false;
    return true;
}

/**
 * Returns the preferred port if it is free, otherwise the next free port above it.
 * Matter controllers find the bridge via mDNS, so a changed port does not break existing pairings.
 */
export async function findFreePort(preferred: number, tcp: boolean, attempts = 20) {
    for (let port = preferred; port < preferred + attempts && port <= 65535; port++) {
        if (await portFree(port, tcp)) return port;
    }
    throw new Error(`No free port found between ${preferred} and ${preferred + attempts - 1}`);
}
