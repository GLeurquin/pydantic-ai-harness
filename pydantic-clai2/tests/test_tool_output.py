"""Native capability events drive terminal-safe specialized output."""

import io

import pytest
from pydantic_ai import FunctionToolCallEvent
from pydantic_ai.messages import ToolCallPart
from pydantic_ai_harness.filesystem import FileEditedEvent
from pydantic_ai_harness.shell import CommandFinishedEvent, CommandOutputEvent, CommandStartedEvent
from rich.console import Console
from rich.text import Text

from pydantic_clai2 import StreamRenderer
from pydantic_clai2.tool_output import FoldedOutputs


@pytest.fixture
def anyio_backend() -> str:
    return 'asyncio'


async def test_shell_header_includes_argument_once() -> None:
    output = io.StringIO()
    renderer = StreamRenderer(Console(file=output), stop_loading=lambda: None)
    await renderer.on_stream_event(
        FunctionToolCallEvent(
            part=ToolCallPart(
                'shell',
                {'command': 'ls /tmp'},
                tool_call_id='shell-call',
            )
        )
    )
    await renderer.on_stream_event(
        CommandStartedEvent(
            tool_call_id='shell-call',
            command='ls /tmp',
            pid=1,
        )
    )
    assert output.getvalue() == '● shell ls /tmp\n\n'


async def test_shell_sgr_colors_across_chunks_and_lines() -> None:
    output = io.StringIO()
    renderer = StreamRenderer(
        Console(file=output, force_terminal=True, color_system='truecolor'), stop_loading=lambda: None
    )
    for chunk in ('\x1b[1;', '35mMAGENTA\n', 'STILL MAGENTA\x1b[0m\n', '\x1b[2J\x1b]52;c;payload\x07safe\n'):
        await renderer.on_stream_event(CommandOutputEvent(tool_call_id='colors', text=chunk))
    rendered = output.getvalue()
    plain = Text.from_ansi(rendered).plain
    assert 'MAGENTA\nSTILL MAGENTA' in plain
    assert '\\x1b[1;35m' not in plain
    assert '\x1b[2J' not in rendered and '\x1b]52;' not in rendered
    assert '35m' in rendered
    assert '\\x1b[2J' in plain


@pytest.mark.parametrize(
    ('name', 'args', 'expected'),
    [
        ('list_files', {}, "● list_files '.' recursive=true limit=200"),
        (
            'list_files',
            {'path': '/tmp', 'glob': '*.cpp', 'limit': 10},
            "● list_files '/tmp' recursive=true limit=10 glob='*.cpp'",
        ),
        ('read_file', {'path': '/tmp/example.cpp'}, "● read_file '/tmp/example.cpp' offset=0 limit=2000 lines"),
        ('read_file', {'path': 'main.py', 'offset': 20, 'limit': 15}, "● read_file 'main.py' offset=20 limit=15 lines"),
        (
            'read_file',
            {'path': 'main.py', 'limit': 5000},
            "● read_file 'main.py' offset=0 limit=2000 lines (requested 5000)",
        ),
    ],
)
async def test_inspection_headers(name: str, args: dict[str, object], expected: str) -> None:
    output = io.StringIO()
    renderer = StreamRenderer(Console(file=output, width=160), stop_loading=lambda: None)
    await renderer.on_stream_event(FunctionToolCallEvent(part=ToolCallPart(name, args, tool_call_id='inspect')))
    assert output.getvalue() == expected + '\n\n'


async def test_shell_event_display() -> None:
    output = io.StringIO()
    renderer = StreamRenderer(Console(file=output), stop_loading=lambda: None)
    await renderer.on_stream_event(CommandStartedEvent(tool_call_id='1', command='printf hello', pid=12))
    await renderer.on_stream_event(CommandOutputEvent(tool_call_id='1', text='hello\x1b]52;c;payload\x07'))
    await renderer.on_stream_event(
        CommandFinishedEvent(
            tool_call_id='1',
            pid=12,
            output_path='/tmp/output.log',
            status_path='/tmp/status.json',
            exit_code=0,
            truncated=True,
        )
    )
    assert '● shell printf hello' in output.getvalue()
    assert 'hello' in output.getvalue()
    assert '\x1b]52;' not in output.getvalue()
    assert 'truncated' in output.getvalue()


def _finished(tool_call_id: str, *, truncated: bool = False, total_lines: int | None = 0) -> CommandFinishedEvent:
    return CommandFinishedEvent(
        tool_call_id=tool_call_id,
        pid=1,
        output_path='/tmp/out',
        status_path='/tmp/status',
        exit_code=0,
        truncated=truncated,
        total_lines=total_lines,
    )


@pytest.mark.parametrize(('limit', 'shown'), [(0, 4), (1, 1), (3, 3), (4, 4), (5, 4)])
async def test_shell_output_folds_after_limit(limit: int, shown: int) -> None:
    output = io.StringIO()
    folds = FoldedOutputs()
    renderer = StreamRenderer(Console(file=output), stop_loading=lambda: None, tool_output_lines=limit, folds=folds)
    for chunk in ('fir', 'st\nsecond', '\nthird\nfourth'):
        await renderer.on_stream_event(CommandOutputEvent(tool_call_id='test', text=chunk))
    await renderer.on_stream_event(_finished('test', total_lines=4))
    text = output.getvalue()
    rows = ['first', 'second', 'third', 'fourth']
    assert [row for row in rows if row in text] == rows[:shown]
    folded = shown < 4
    assert (f'... {4 - shown} more lines (/expand to show)' in text) == folded
    assert len(folds) == int(folded)


async def test_expand_reprints_folded_outputs_newest_first() -> None:
    output = io.StringIO()
    console = Console(file=output, width=200)
    folds = FoldedOutputs(keep=2)
    assert folds.expand(console, []) == 'Nothing to expand: no tool output has been folded yet.'
    renderer = StreamRenderer(console, stop_loading=lambda: None, tool_output_lines=1, folds=folds)
    for call, command in (('one', 'seq 2'), ('two', 'seq 3\nseq 4'), ('three', 'seq 5')):
        await renderer.on_stream_event(CommandStartedEvent(tool_call_id=call, command=command, pid=1))
        await renderer.on_stream_event(CommandOutputEvent(tool_call_id=call, text=f'{call} a\n{call} b\n{call} c'))
        await renderer.on_stream_event(_finished(call))
    assert 'two b' not in output.getvalue() and len(folds) == 2
    output.truncate(0)
    output.seek(0)
    assert folds.expand(console, []) == '3 lines.'
    assert output.getvalue() == '● shell seq 5\nthree a\nthree b\nthree c\n'
    output.truncate(0)
    output.seek(0)
    assert folds.expand(console, ['2']) == '3 lines.'
    assert output.getvalue() == '● shell seq 3 (+1 command lines)\ntwo a\ntwo b\ntwo c\n'
    assert folds.expand(console, ['3']) == 'Only 2 folded output(s) are kept; use /expand 1 to /expand 2.'
    assert folds.expand(console, ['0']).startswith('Only 2')
    with pytest.raises(ValueError, match='Usage: /expand'):
        folds.expand(console, ['last'])
    with pytest.raises(ValueError, match='Usage: /expand'):
        folds.expand(console, ['1', '2'])


@pytest.mark.parametrize(('total_lines', 'note'), [(9, '7 more lines are'), (None, 'the rest is'), (1, 'the rest is')])
async def test_shell_reports_output_beyond_the_event_budget(total_lines: int | None, note: str) -> None:
    output = io.StringIO()
    renderer = StreamRenderer(Console(file=output), stop_loading=lambda: None)
    await renderer.on_stream_event(CommandOutputEvent(tool_call_id='big', text='one\ntwo\n'))
    await renderer.on_stream_event(_finished('big', truncated=True, total_lines=total_lines))
    assert f'Output truncated by the event budget; {note} only in the command log.' in output.getvalue()
    assert '/expand' not in output.getvalue()


async def test_shell_progress_replaces_carriage_return_frames() -> None:
    output = io.StringIO()
    renderer = StreamRenderer(Console(file=output, width=80), stop_loading=lambda: None)
    await renderer.on_stream_event(
        CommandStartedEvent(
            tool_call_id='progress',
            command='python3 - <<PY\nprint(123)\nPY',
            pid=1,
        )
    )
    for chunk in ('header\r', '\n10%', '\r50%', '\r', '100%\n', 'done'):
        await renderer.on_stream_event(CommandOutputEvent(tool_call_id='progress', text=chunk))
    await renderer.on_stream_event(
        CommandFinishedEvent(
            tool_call_id='progress',
            pid=1,
            output_path='/tmp/out',
            status_path='/tmp/status',
            exit_code=0,
            truncated=False,
            total_lines=3,
        )
    )
    text = output.getvalue()
    assert 'header\n100%\ndone\n' in text
    assert '10%' not in text and '50%' not in text and '\\x0d' not in text
    assert '(+2 command lines)' in text and 'print(123)' not in text
    assert 'Truncated' not in text


async def test_edit_uses_termflow_diff_renderer() -> None:
    output = io.StringIO()
    renderer = StreamRenderer(Console(file=output, force_terminal=True), stop_loading=lambda: None)
    await renderer.on_stream_event(
        FileEditedEvent(
            path='demo.py',
            root_dir='/tmp',
            content_hash='hash',
            diff='--- a/demo.py\n+++ b/demo.py\n@@ -1 +1 @@\n-old\n+new\n',
            truncated=False,
        )
    )
    text = output.getvalue()
    assert '● edit_file demo.py' in Text.from_ansi(text).plain
    assert 'old' in text and 'new' in text
    assert '\x1b[48;2;70;82;88m' in text  # addition rows: Aqua over Dark Purple
    assert '\x1b[48;2;104;43;54m' in text  # deletion rows: Calcium over Dark Purple
