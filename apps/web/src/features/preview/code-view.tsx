import { defaultKeymap } from '@codemirror/commands'
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import {
  closeSearchPanel,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import {
  drawSelection,
  EditorView,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import type { ViewHandle } from './view-handle'

interface CodeViewProps {
  text: string
  /** The file's name, which says its language. */
  name: string
  wrap: boolean
  ref?: Ref<ViewHandle>
}

/** The viewer's colours: always dark, as the viewer is. */
const theme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.6' },
    '.cm-content': { padding: '12px 0', caretColor: 'var(--foreground)' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--muted-foreground)',
      border: 'none',
      paddingLeft: '8px',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 4px', minWidth: '40px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'color-mix(in oklch, var(--primary) 35%, transparent) !important',
    },
    '.cm-selectionMatch': {
      backgroundColor: 'color-mix(in oklch, var(--primary) 20%, transparent)',
    },
    '.cm-searchMatch': { backgroundColor: 'color-mix(in oklch, orange 30%, transparent)' },
    '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in oklch, orange 55%, transparent)' },
    '.cm-panels': {
      backgroundColor: 'var(--popover)',
      color: 'var(--popover-foreground)',
      borderColor: 'var(--border)',
    },
    '.cm-panels-top': { borderBottom: '1px solid var(--border)' },
    '.cm-panel.cm-search': { padding: '6px 8px', fontFamily: "'Geist Variable', sans-serif" },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontSize: '12px' },
    '.cm-textfield': {
      backgroundColor: 'var(--input)',
      border: '1px solid var(--border)',
      borderRadius: '6px',
      color: 'inherit',
    },
    '.cm-button': {
      backgroundImage: 'none',
      backgroundColor: 'var(--secondary)',
      border: '1px solid var(--border)',
      borderRadius: '6px',
      color: 'inherit',
    },
  },
  { dark: true },
)

/**
 * Text in a read-only CodeMirror (§10.3): colours for its language, loaded
 * when first needed, line numbers, wrapping, search (Ctrl+F), and only the
 * lines on screen drawn, so a large log scrolls smoothly.
 */
export function CodeView({ text, name, wrap, ref }: CodeViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const wrapping = useRef(new Compartment())
  const language = useRef(new Compartment())

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          lineNumbers(),
          highlightSpecialChars(),
          drawSelection(),
          highlightSelectionMatches(),
          search({ top: true }),
          keymap.of([...searchKeymap, ...defaultKeymap]),
          syntaxHighlighting(oneDarkHighlightStyle),
          theme,
          wrapping.current.of([]),
          language.current.of([]),
        ],
      }),
    })
    view.current = editor
    let current = true
    void LanguageDescription.matchFilename(languages, name)
      ?.load()
      .then((support) => {
        if (current) editor.dispatch({ effects: language.current.reconfigure(support) })
      })
    return () => {
      current = false
      view.current = null
      editor.destroy()
    }
  }, [text, name])

  useEffect(() => {
    view.current?.dispatch({
      effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    })
  }, [wrap, text])

  useImperativeHandle(ref, () => ({
    find: () => {
      const editor = view.current
      if (!editor) return
      editor.focus()
      openSearchPanel(editor)
    },
    dismiss: () => (view.current ? closeSearchPanel(view.current) : false),
  }))

  return <div ref={host} className="size-full font-mono" />
}
