# ==============================================================================
# WavePass HotSpot Auto-Configuration Script (RouterOS v7+)
# Paste this entire script into Winbox/SSH Terminal, or run: /import wavepass-setup.rsc
# ==============================================================================

:log info "WavePass: Starting automated Hotspot configuration..."

# 1. Router Credentials
# WavePass uses the router's existing 'admin' user with its default/configured password.
# No extra 'wavepass' user is created, ensuring full compatibility with WinBox, MikroTik app, and WavePass.
:log info "WavePass: Using default/configured router admin credentials."

# 2. Enable REST API / HTTP service for WavePass control
/ip/service/enable [find name="www"]
/ip/service/enable [find name="www-ssl"]

# 3. Add Paystack, WavePass portal & backend to Hotspot Walled Garden (bypass before login — so any page hit shows landing)
# The hotspot intercepts unauth HTTP and redirects to portal; walled garden keeps the landing + payments reachable.
/ip/hotspot/walled-garden/ip add dst-host="*.paystack.co" action=accept comment="WavePass: Paystack API"
/ip/hotspot/walled-garden/ip add dst-host="*.paystack.com" action=accept comment="WavePass: Paystack Checkout"
/ip/hotspot/walled-garden/ip add dst-host="checkout.paystack.com" action=accept comment="WavePass: Paystack Checkout Host"
/ip/hotspot/walled-garden/ip add dst-host="*.supabase.co" action=accept comment="WavePass: Supabase backend"
/ip/hotspot/walled-garden/ip add dst-host="nexawavepass.com" action=accept comment="WavePass: Web portal (landing)"
/ip/hotspot/walled-garden/ip add dst-host="*.nexawavepass.com" action=accept comment="WavePass: Venue subdomains"
/ip/hotspot/walled-garden/ip add dst-host="*.vercel.app" action=accept comment="WavePass: Vercel portal"
/ip/hotspot/walled-garden add dst-host="portal.nexawavepass.local" action=accept comment="WavePass: Local portal"

# 4. Create Standard Plan User Profiles (1h, 12h, 24h)
/ip/hotspot/user/profile add name="profile_1h" session-timeout=1h keepalive-timeout=2m shared-users=1 status-autorefresh=1m rate-limit="10M/5M" comment="WavePass 1-Hour Profile"
/ip/hotspot/user/profile add name="profile_12h" session-timeout=12h keepalive-timeout=2m shared-users=1 status-autorefresh=1m rate-limit="15M/5M" comment="WavePass 12-Hour Profile"
/ip/hotspot/user/profile add name="profile_1d" session-timeout=1d keepalive-timeout=2m shared-users=1 status-autorefresh=1m rate-limit="20M/10M" comment="WavePass 24-Hour Profile"

# 5. Low-RAM Memory Auto-Cleanup Script & Scheduler (Mikhmon Parity)
:if ([:len [/system/script find name="wavepass-cleanup"]] = 0) do={
  /system script add name="wavepass-cleanup" source={/ip hotspot user remove [find comment="expired"]} comment="WavePass expired user purge"
}
:if ([:len [/system/scheduler find name="wavepass-cleanup"]] = 0) do={
  /system scheduler add name="wavepass-cleanup" interval=2h on-event="wavepass-cleanup" comment="WavePass 2-hour user cleanup"
}

:log info "WavePass: Auto-configuration complete! Router is ready for WavePass cloud control."
