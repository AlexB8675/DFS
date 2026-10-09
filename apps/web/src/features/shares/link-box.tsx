import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { copyLink } from './api'

/** A share link to copy (§7.5): its address, selected on focus, and a button that copies it. */
export function LinkBox({ url, label = 'Share link' }: { url: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex gap-2">
      <Input
        readOnly
        value={url}
        aria-label={label}
        className="font-mono text-xs"
        onFocus={(event) => {
          event.currentTarget.select()
        }}
        // In a dialog's form, Enter here would submit it: a link only to copy.
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.preventDefault()
        }}
      />
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          void copyLink(url).then(setCopied)
        }}
      >
        {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}
