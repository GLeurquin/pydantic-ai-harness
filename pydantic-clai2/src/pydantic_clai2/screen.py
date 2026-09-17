"""Terminal housekeeping that touches the screen, never the conversation."""

from rich.console import Console


def clear_screen(console: Console) -> str:
    """Handle `/clear`: wipe the visible screen and, on a real terminal, the scrollback too."""
    console.clear()
    if console.is_terminal:
        console.file.write('\x1b[3J')
        console.file.flush()
    return 'Screen cleared. The conversation is still here; /new starts a fresh one.'
