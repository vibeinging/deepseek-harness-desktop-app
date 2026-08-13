export const toggleHtmlClass = (className: string) => {
  document.querySelectorAll('html')[0].className = className
}
