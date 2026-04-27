import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

export default function MarkdownAnswer({ children }: { children: string }) {
  return (
    <div className="rounded-lg border border-[#1a1d2e] bg-[#10131d] p-4 text-sm leading-6 text-[#dde2f0]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="pl-1">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-[#f3f6ff]">{children}</strong>,
          code: ({ children }) => <code className="rounded bg-[#0c0e16] px-1.5 py-0.5 font-mono text-xs text-[#a7f3d0]">{children}</code>,
          pre: ({ children }) => <pre className="mb-3 overflow-x-auto rounded-lg bg-[#0c0e16] p-3 font-mono text-xs text-[#a7f3d0]">{children}</pre>,
          h1: ({ children }) => <h1 className="mb-3 text-lg font-bold text-[#e8eaf6]">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-3 text-base font-bold text-[#e8eaf6]">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 text-sm font-bold text-[#e8eaf6]">{children}</h3>,
          table: ({ children }) => <div className="mb-3 overflow-x-auto"><table className="w-full border-collapse text-xs">{children}</table></div>,
          th: ({ children }) => <th className="border border-[#1d2135] bg-[#0c0e16] px-2 py-1 text-left font-semibold text-[#8892b0]">{children}</th>,
          td: ({ children }) => <td className="border border-[#1d2135] px-2 py-1 text-[#dde2f0]">{children}</td>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
