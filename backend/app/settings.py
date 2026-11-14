"""Deploy settings; a single process is mandatory because Motor has one in-memory session."""
from __future__ import annotations
from dataclasses import dataclass, field
from pathlib import Path
import os

ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    terrain_dir: Path = field(default_factory=lambda: Path(os.getenv('ARES_TERRAIN_DIR', ROOT / 'terreno')).resolve())
    examples_dir: Path = field(default_factory=lambda: Path(os.getenv('ARES_EXAMPLES_DIR', ROOT / 'contratos' / 'ejemplos')).resolve())
    logs_dir: Path = field(default_factory=lambda: Path(os.getenv('ARES_LOGS_DIR', ROOT / 'logs')).resolve())
    cors_origins: tuple[str, ...] = field(default_factory=lambda: tuple(
        o.strip() for o in os.getenv('ARES_CORS_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173').split(',') if o.strip()))
    write_token: str = field(default_factory=lambda: os.getenv('ARES_WRITE_TOKEN', ''))
    read_token: str = field(default_factory=lambda: os.getenv('ARES_READ_TOKEN', ''))
    ws_queue_limit: int = 256
    ws_message_bytes: int = 128 * 1024
