"""Append-only per-EVA JSONL, readable by VR and demo replay clients."""
from __future__ import annotations
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import uuid


class Journal:
    def __init__(self, folder: Path):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.path: Path | None = None

    def new_session(self, escenario_id: str) -> Path:
        clean = re.sub(r'[^a-zA-Z0-9_-]', '_', escenario_id)[:48]
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        self.path = self.folder / f'sesion-{stamp}-{clean}-{uuid.uuid4().hex[:8]}.jsonl'
        return self.path

    def record(self, direction: str, payload: dict, channel: str) -> None:
        if self.path is None:
            return
        item = {
            'timestamp_utc': datetime.now(timezone.utc).isoformat(),
            'direccion': direction, 'canal': channel, 'mensaje': payload,
        }
        with self.path.open('a', encoding='utf-8') as f:
            f.write(json.dumps(item, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n')
