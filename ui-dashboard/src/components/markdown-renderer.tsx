"use client";

import type { ComponentProps, ReactNode } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

// Defense-in-depth: forensic-report bodies are written by workspace users
// (auth-gated, Google Workspace-restricted). They're not adversarial inputs
// in the threat model, but rehype-sanitize is cheap and protects against
// accidental script tags from copy-pasted HTML.
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // Allow language hints on code blocks (`bash`, `solidity`, etc.) — react-
    // markdown emits them as `className="language-xxx"` on <code>.
    code: [...(defaultSchema.attributes?.code ?? []), ["className"]],
  },
};

// Hoisted to module scope so referential identity is stable across renders.
// react-markdown uses the props object identity to skip re-parses on
// unchanged input — fresh array literals per render defeated that.
const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm];
const REHYPE_PLUGINS: Options["rehypePlugins"] = [
  [rehypeSanitize, sanitizeSchema],
];

const COMPONENTS: Components = {
  h1: ({ children, ...props }) => (
    <h1 className="mt-4 mb-2 text-base font-semibold text-white" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="mt-4 mb-2 text-sm font-semibold text-white" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="mt-3 mb-1 text-sm font-medium text-slate-100" {...props}>
      {children}
    </h3>
  ),
  p: (props) => (
    <p className="my-2 leading-relaxed text-slate-300" {...props} />
  ),
  a: ({ href, children, ...props }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-indigo-300 underline decoration-indigo-700 underline-offset-2 hover:text-indigo-200"
      {...props}
    >
      {children}
    </a>
  ),
  ul: (props) => (
    <ul className="my-2 list-disc space-y-1 pl-5 text-slate-300" {...props} />
  ),
  ol: (props) => (
    <ol
      className="my-2 list-decimal space-y-1 pl-5 text-slate-300"
      {...props}
    />
  ),
  li: (props) => <li className="leading-relaxed" {...props} />,
  blockquote: (props) => (
    <blockquote
      className="my-2 border-l-2 border-slate-700 pl-3 italic text-slate-400"
      {...props}
    />
  ),
  code: ({
    className: codeClass,
    children: codeChildren,
    ...rest
  }: ComponentProps<"code"> & { children?: ReactNode }) => {
    // Inline code = no className; fenced code = "language-xxx".
    const isBlock = typeof codeClass === "string";
    if (isBlock) {
      return (
        <code
          className={`${codeClass} block whitespace-pre overflow-x-auto`}
          {...rest}
        >
          {codeChildren}
        </code>
      );
    }
    return (
      <code
        className="rounded bg-slate-800 px-1 py-0.5 font-mono text-xs text-indigo-300"
        {...rest}
      >
        {codeChildren}
      </code>
    );
  },
  pre: (props) => (
    <pre
      className="my-2 overflow-x-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs"
      {...props}
    />
  ),
  table: (props) => (
    <div className="my-3 overflow-x-auto">
      <table className="min-w-full border-collapse text-xs" {...props} />
    </div>
  ),
  thead: (props) => <thead className="border-b border-slate-700" {...props} />,
  th: (props) => (
    <th
      className="px-2 py-1.5 text-left font-semibold text-slate-200"
      {...props}
    />
  ),
  td: (props) => (
    <td
      className="border-b border-slate-800 px-2 py-1.5 align-top text-slate-300"
      {...props}
    />
  ),
  hr: () => <hr className="my-4 border-slate-800" />,
  strong: (props) => <strong className="font-semibold text-white" {...props} />,
  em: (props) => <em className="text-slate-200" {...props} />,
};

type Props = {
  /** Markdown body to render. */
  children: string;
  /** Extra Tailwind classes for the wrapper. */
  className?: string;
};

/**
 * Tight, dark-themed markdown renderer for forensic-report bodies. No
 * `@tailwindcss/typography` dep — each tag is styled via component overrides
 * to keep dashboard styling consistent with the rest of the app.
 */
export function MarkdownRenderer({ children, className = "" }: Props) {
  return (
    <div className={`text-sm text-slate-200 ${className}`}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
