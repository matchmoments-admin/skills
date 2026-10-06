"""vtlib — the pure half of the video toolkit.

Nothing in this package touches the filesystem, the network, or a subprocess.
Every module here takes plain data in and returns plain data out, which is what
makes the pipeline testable without ffmpeg or a network, and what will let the
signals/candidates stages run inside a Cloudflare Worker with R2 in place of a
local cache. `vt.py` owns all I/O and is a thin adapter over these functions.

There is a test that enforces the no-I/O rule by reading these sources.
"""

from .errors import VtError

__all__ = ["VtError"]
