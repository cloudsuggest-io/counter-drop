import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { I18nProvider } from '@/lib/i18n'
import Home from '@/customer/Home'
import DropPage from '@/customer/DropPage'
import TicketPage from '@/customer/TicketPage'
import ScanPage from '@/customer/ScanPage'
import { PrivacyPage, TermsPage } from '@/customer/LegalPages'
import { RequireStaff, ShopAuthProvider } from '@/shop/auth'
import LoginPage from '@/shop/LoginPage'
import BoardPage from '@/shop/BoardPage'
import SettingsPage from '@/shop/SettingsPage'
import QrPage from '@/shop/QrPage'
import SetupPage from '@/shop/SetupPage'
import AccountPage from '@/shop/AccountPage'
import DashboardPage from '@/shop/DashboardPage'

// Customer routes (/, /s/:slug, /t/:jobId) and /shop/login, /shop/setup are public; other /shop/* need a staff session.
export default function App() {
  return (
    <BrowserRouter>
      <I18nProvider>
        <ShopAuthProvider>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/s/:slug" element={<DropPage />} />
            <Route path="/t/:jobId" element={<TicketPage />} />
            <Route path="/scan" element={<ScanPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/shop/login" element={<LoginPage />} />
            <Route path="/shop/setup" element={<SetupPage />} />
            <Route path="/shop/account" element={<RequireStaff><AccountPage /></RequireStaff>} />
            <Route path="/shop" element={<RequireStaff><BoardPage /></RequireStaff>} />
            <Route path="/shop/qr" element={<RequireStaff><QrPage /></RequireStaff>} />
            <Route path="/shop/settings" element={<RequireStaff owner><SettingsPage /></RequireStaff>} />
            <Route path="/shop/dashboard" element={<RequireStaff owner><DashboardPage /></RequireStaff>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ShopAuthProvider>
      </I18nProvider>
    </BrowserRouter>
  )
}
