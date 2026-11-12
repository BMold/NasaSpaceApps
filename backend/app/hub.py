"""Per-connection bounded queues; motor lock never waits on slow viewers."""
from __future__ import annotations
import asyncio
from dataclasses import dataclass, field
from fastapi import WebSocket


@dataclass(eq=False)
class Client:
    socket: WebSocket
    role: str
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)


class Hub:
    def __init__(self, max_queue: int = 256):
        self.max_queue = max_queue
        self.clients: set[Client] = set()
        self.writer: Client | None = None

    def attach(self, socket: WebSocket, role: str) -> Client | None:
        if role == 'dana' and self.writer is not None:
            return None
        client = Client(socket=socket, role=role, queue=asyncio.Queue(self.max_queue))
        self.clients.add(client)
        if role == 'dana':
            self.writer = client
        return client

    def detach(self, client: Client) -> None:
        self.clients.discard(client)
        if self.writer is client:
            self.writer = None

    def enqueue(self, message: dict, roles: tuple[str, ...] = ('front', 'vr')) -> None:
        for client in tuple(self.clients):
            if client.role in roles:
                try:
                    client.queue.put_nowait(message)
                except asyncio.QueueFull:
                    # Slow viewers are disconnected instead of silently missing events.
                    self.detach(client)
                    asyncio.create_task(self._close_slow(client))

    @staticmethod
    async def _close_slow(client: Client):
        try:
            await client.socket.close(code=1013, reason='Suscriptor demasiado lento')
        except Exception:
            pass

    async def sender(self, client: Client) -> None:
        while client in self.clients:
            item = await client.queue.get()
            await client.socket.send_json(item)
