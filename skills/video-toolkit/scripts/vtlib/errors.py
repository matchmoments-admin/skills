"""The one error type the pipeline raises deliberately."""


class VtError(Exception):
    """An anticipated failure with a message meant for the caller.

    Raised, never printed. `vt.py`'s main() is the only place that catches it,
    turns it into the `{"ok": false, "error": ...}` envelope and sets an exit
    code — which is exactly the handler a Worker replaces with a 400 response.

    Stages that call sys.exit() cannot be called twice in one process, cannot be
    tested without catching SystemExit, and cannot run inside a request handler.
    """
