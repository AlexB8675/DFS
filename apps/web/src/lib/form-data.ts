/** Reads a text field from a form submission; missing fields and files read as `""`. */
export function formText(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value : ''
}
