import { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'

// Clé de stockage du hash du code PIN dans la table de configuration.
export const PIN_CONFIG_KEY = 'access_pin_hash'

export const authOptions: NextAuthOptions = {
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  providers: [
    CredentialsProvider({
      name: 'Code PIN',
      credentials: {
        pin: { label: 'Code PIN', type: 'password' },
      },
      async authorize(credentials) {
        const pin = String(credentials?.pin ?? '').trim()
        // Un seul identifiant possible : un code PIN à 6 chiffres.
        if (!/^\d{6}$/.test(pin)) return null
        const cfg = await prisma.app_config.findUnique({ where: { key: PIN_CONFIG_KEY } })
        if (!cfg?.value) return null
        const valid = await bcrypt.compare(pin, cfg.value)
        if (!valid) return null
        return { id: 'pin-user', email: 'dashboard', name: 'Utilisateur' }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) {
        token.id = user.id
      }
      return token
    },
    async session({ session, token }) {
      if (session?.user && token?.id) {
        session.user.id = token.id
      }
      return session
    },
  },
}
