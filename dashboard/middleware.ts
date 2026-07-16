export { default } from 'next-auth/middleware'

export const config = {
  matcher: [
    '/((?!api|login|_next/static|_next/image|favicon.svg|og-image.png|.*\\..*).*)',
  ],
}
