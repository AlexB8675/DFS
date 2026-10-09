// Toasts over modal dialogs: a modal (the viewer, a rename) turns off
// pointer events everywhere outside it, which the toaster takes back
// (components/ui/sonner.tsx), and takes a press outside it for a dismissal,
// which a press on a toast is not: the update notice's Reload, say.

/** Lets a press on a toast through without closing the dialog under it. */
export function keepOpenForToasts(event: {
  target: EventTarget | null
  preventDefault: () => void
}) {
  if (event.target instanceof Element && event.target.closest('[data-sonner-toaster]')) {
    event.preventDefault()
  }
}
