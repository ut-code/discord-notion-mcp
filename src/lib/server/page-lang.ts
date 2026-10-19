const LANG_PLACEHOLDER = '<html lang="%lang%"';

/** Fills the `lang` of app.html's <html> tag; page text that spells the placeholder is left alone. */
export function withPageLang(html: string, locale: string): string {
  return html.replace(LANG_PLACEHOLDER, `<html lang="${locale}"`);
}
