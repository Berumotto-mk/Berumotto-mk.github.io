export function needsSource(markdown){
  const prose=markdown.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm,'').replace(/<br\s*\/?>/gi,'');
  return /<\/?[a-z][\w-]*(?:\s[^>]*|\s*\/?)>|<!--[\s\S]*?-->|\{\{[<%]/i.test(prose);
}
