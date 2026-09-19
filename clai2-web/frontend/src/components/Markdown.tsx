import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import yaml from 'highlight.js/lib/languages/yaml';

// A curated set matching what this product's agents actually run, not
// highlight.js's full ~190-grammar catalog -- keeps the bundle small.
// Registered under both their canonical name and the short form models
// commonly tag fences with (```py, ```sh, ```ts, ...).
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('go', go);
hljs.registerLanguage('golang', go);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);

const COPIED_LABEL_MS = 1500;

// react-markdown always hands a code element's content as a single string
// (or undefined for an empty fence) -- mdast-util-to-hast emits code blocks
// as one literal text node, never a mix of child nodes.
function childrenToString(children: ReactNode): string {
  return typeof children === 'string' ? children : '';
}

function CodeBlock({ language, code }: { language: string | null; code: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    },
    [],
  );

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => setCopied(false), COPIED_LABEL_MS);
  };

  const highlighted = language && hljs.getLanguage(language) ? hljs.highlight(code, { language, ignoreIllegals: true }).value : null;

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{language ?? 'code'}</span>
        <button type="button" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        {highlighted ? (
          // highlight.js escapes the source before wrapping it in span tags,
          // so this never injects anything beyond what hljs itself produced.
          <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </div>
  );
}

const components: Components = {
  // Model-authored links open in a new tab; `noreferrer` matches the same
  // pattern already used for the issue-preview link in NewAgentDialog.tsx.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  // react-markdown maps every `code` node (inline span or fenced block)
  // through this one component. A fenced block either carries a
  // `language-xxx` class from remark, or -- for a fence with no language
  // tag -- no class at all; multi-line content is the fallback signal for
  // that case, since an inline code span is never itself multi-line.
  // `pre` is overridden to a no-op passthrough so this component's own
  // `<pre>` (with its copy-button header) is the only one rendered -- the
  // default react-markdown wrapping would otherwise double up.
  code: ({ className, children }) => {
    const text = childrenToString(children).replace(/\n$/, '');
    const match = /language-(\w+)/.exec(className ?? '');
    const language = match?.[1] ?? null;
    if (language !== null || text.includes('\n')) {
      return <CodeBlock language={language} code={text} />;
    }
    return <code>{text}</code>;
  },
  pre: ({ children }) => <>{children}</>,
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
