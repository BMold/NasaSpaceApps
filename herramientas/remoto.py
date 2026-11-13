"""Lectura por rangos de archivos grandes en servidores de la NASA/USGS, sin bajarlos enteros.

HTTPS con verificacion COMPLETA. `truststore` hace que Python use el almacen de certificados del
sistema operativo (igual que curl en Windows); necesario si un antivirus inspecciona el trafico
TLS con su propia CA instalada en el sistema. No se desactiva ninguna verificacion.
"""
import io
from collections import OrderedDict

import requests
import truststore

truststore.inject_into_ssl()


class RangeFile(io.RawIOBase):
    """Archivo remoto de solo lectura y con seek, apoyado en peticiones HTTP Range con cache de bloques."""

    def __init__(self, url, bloque=1 << 20, max_bloques=512):
        self.s = requests.Session()
        r = self.s.head(url, allow_redirects=True, timeout=60)
        r.raise_for_status()
        if "bytes" not in r.headers.get("Accept-Ranges", ""):
            raise OSError(f"{url}: el servidor no admite lectura por rangos")
        self.url, self.size = r.url, int(r.headers["Content-Length"])
        self.name, self.bloque, self.max_bloques = url, bloque, max_bloques
        self.cache, self.pos = OrderedDict(), 0
        self.bytes_descargados, self.peticiones = 0, 0

    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def _bloque(self, i):
        if i in self.cache:
            self.cache.move_to_end(i)
            return self.cache[i]
        a, b = i * self.bloque, min(self.size, (i + 1) * self.bloque) - 1
        for intento in range(4):
            try:
                r = self.s.get(self.url, headers={"Range": f"bytes={a}-{b}"}, timeout=120)
                if r.status_code == 206 and len(r.content) == b - a + 1:
                    break
            except requests.RequestException:
                pass
        else:
            raise OSError(f"fallo al leer bytes {a}-{b} de {self.url}")
        self.peticiones += 1
        self.bytes_descargados += len(r.content)
        self.cache[i] = r.content
        if len(self.cache) > self.max_bloques:
            self.cache.popitem(last=False)
        return r.content

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        out, fin = [], self.pos + n
        while self.pos < fin:
            i, off = divmod(self.pos, self.bloque)
            trozo = self._bloque(i)[off:off + fin - self.pos]
            out.append(trozo)
            self.pos += len(trozo)
        return b"".join(out)

    def readinto(self, b):
        d = self.read(len(b))
        b[:len(d)] = d
        return len(d)
