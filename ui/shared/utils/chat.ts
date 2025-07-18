// Chat utility functions

// Check if a string is a valid image URL
export function isImageUrl(text: string): boolean {
  try {
    const url = new URL(text.trim());
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
    const pathname = url.pathname.toLowerCase();
    return imageExtensions.some(ext => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

// Parse message content and identify image URLs
export function parseMessageContent(content: string): { type: 'text' | 'image', value: string }[] {
  const parts: { type: 'text' | 'image', value: string }[] = [];
  const words = content.split(/\s+/);
  
  let currentText = '';
  
  for (const word of words) {
    if (isImageUrl(word)) {
      // Add any accumulated text
      if (currentText) {
        parts.push({ type: 'text', value: currentText.trim() });
        currentText = '';
      }
      // Add the image URL
      parts.push({ type: 'image', value: word });
    } else {
      currentText += (currentText ? ' ' : '') + word;
    }
  }
  
  // Add any remaining text
  if (currentText) {
    parts.push({ type: 'text', value: currentText.trim() });
  }
  
  return parts;
}