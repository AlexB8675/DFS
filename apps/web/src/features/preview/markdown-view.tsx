import { ImageOff } from 'lucide-react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Markdown formatted (§10.3): GitHub's flavour, without raw HTML, so
// nothing in the file runs. Its images aren't loaded: the CSP stops other
// sites', and one on this site would be a request made in the reader's name
// (a share link's download, say), so each shows as its description.

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ alt }) => (
    <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-sm text-muted-foreground">
      <ImageOff className="size-3.5" aria-hidden />
      {alt?.trim() ? alt : 'Image'}
    </span>
  ),
}

/** A Markdown file as it reads, in a column. */
export default function MarkdownView({ text }: { text: string }) {
  return (
    <div className="size-full overflow-y-auto">
      <article className="markdown mx-auto max-w-3xl px-6 py-8 text-[15px] leading-7">
        <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
          {text}
        </Markdown>
      </article>
    </div>
  )
}
