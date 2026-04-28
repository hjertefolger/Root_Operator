import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const remarkPlugins = [remarkGfm];

const MONO = "'SF Mono','Menlo','Consolas','Liberation Mono',monospace";

const mdComponents = {
  p: ({ children }) => (
    <p style={{ marginTop: 0, marginBottom: '0.75em', lineHeight: 1.45, wordBreak: 'break-word' }}>{children}</p>
  ),
  strong: ({ children }) => (
    <strong style={{ fontWeight: 600, color: 'rgba(255,255,255,0.95)' }}>{children}</strong>
  ),
  em: ({ children }) => (
    <em>{children}</em>
  ),
  code: ({ inline, children }) => {
    if (inline) {
      return (
        <code style={{
          backgroundColor: 'rgba(255,255,255,0.1)',
          padding: '2px 6px',
          borderRadius: 4,
          fontSize: '0.9em',
          fontFamily: MONO,
          border: '1px solid rgba(255,255,255,0.08)',
          wordBreak: 'break-word',
        }}>{children}</code>
      );
    }
    return (
      <code style={{
        display: 'block',
        fontSize: 13,
        fontFamily: MONO,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'rgba(255,255,255,0.88)',
      }}>{children}</code>
    );
  },
  pre: ({ children }) => (
    <pre style={{
      backgroundColor: 'rgba(0,0,0,0.4)',
      padding: '12px 14px',
      borderRadius: 8,
      marginTop: '0.5em',
      marginBottom: '0.75em',
      overflowX: 'auto',
      WebkitOverflowScrolling: 'touch',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>{children}</pre>
  ),
  ul: ({ children }) => (
    <ul style={{ marginTop: '0.5em', marginBottom: '0.75em', paddingLeft: '1.5em', lineHeight: 1.45, listStyleType: 'disc' }}>{children}</ul>
  ),
  ol: ({ children }) => (
    <ol style={{ marginTop: '0.5em', marginBottom: '0.75em', paddingLeft: '1.5em', lineHeight: 1.45 }}>{children}</ol>
  ),
  li: ({ children }) => (
    <li style={{ marginTop: '0.25em', marginBottom: '0.25em' }}>{children}</li>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#8b9aff', textDecoration: 'underline' }}>{children}</a>
  ),
  blockquote: ({ children }) => (
    <blockquote style={{
      borderLeft: '3px solid rgba(255,255,255,0.25)',
      paddingLeft: '1em',
      marginTop: '0.5em',
      marginBottom: '0.75em',
      marginLeft: 0,
      marginRight: 0,
      color: 'rgba(255,255,255,0.7)',
      fontStyle: 'italic',
    }}>{children}</blockquote>
  ),
  hr: () => (
    <hr style={{ border: 'none', borderTop: '1px solid rgba(255,255,255,0.12)', marginTop: '1em', marginBottom: '1em' }} />
  ),
  h1: ({ children }) => (
    <p style={{ fontSize: '1.35em', lineHeight: 1.3, fontWeight: 700, marginTop: '1em', marginBottom: '0.5em', color: 'rgba(255,255,255,0.95)' }}>{children}</p>
  ),
  h2: ({ children }) => (
    <p style={{ fontSize: '1.2em', lineHeight: 1.3, fontWeight: 600, marginTop: '1em', marginBottom: '0.4em', color: 'rgba(255,255,255,0.95)' }}>{children}</p>
  ),
  h3: ({ children }) => (
    <p style={{ fontSize: '1.1em', lineHeight: 1.3, fontWeight: 600, marginTop: '0.8em', marginBottom: '0.3em', color: 'rgba(255,255,255,0.95)' }}>{children}</p>
  ),
  h4: ({ children }) => (
    <p style={{ fontSize: '1em', lineHeight: 1.3, fontWeight: 600, marginTop: '0.75em', marginBottom: '0.25em', color: 'rgba(255,255,255,0.95)' }}>{children}</p>
  ),
  h5: ({ children }) => (
    <p style={{ fontSize: '1em', lineHeight: 1.3, fontWeight: 600, marginTop: '0.75em', marginBottom: '0.25em', color: 'rgba(255,255,255,0.95)' }}>{children}</p>
  ),
  h6: ({ children }) => (
    <p style={{ fontSize: '1em', lineHeight: 1.3, fontWeight: 600, marginTop: '0.75em', marginBottom: '0.25em', color: 'rgba(255,255,255,0.95)' }}>{children}</p>
  ),
  table: ({ children }) => (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', marginTop: '0.5em', marginBottom: '0.75em' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9em' }}>{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th style={{ backgroundColor: 'rgba(255,255,255,0.08)', fontWeight: 600, textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.95)', whiteSpace: 'nowrap' }}>{children}</th>
  ),
  td: ({ children }) => (
    <td style={{ padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.85)' }}>{children}</td>
  ),
};

const MessageMarkdown = memo(function MessageMarkdown({ content }) {
  return (
    <div className="msg-md" style={{ fontSize: 15, lineHeight: 1.45, wordBreak: 'break-word' }}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={mdComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
});

export default MessageMarkdown;
export { mdComponents, remarkPlugins };
