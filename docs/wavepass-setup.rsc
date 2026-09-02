# ==============================================================================
# WavePass HotSpot Auto-Configuration Script (RouterOS v7+)
# Paste this entire script into Winbox/SSH Terminal, or run: /import wavepass-setup.rsc
# ==============================================================================

:log info "WavePass: Starting automated Hotspot configuration..."

# 1. Create dedicated least-privilege WavePass API user
:if ([:len [/system/user find name="wavepass"]] = 0) do={
    /system/user add name="wavepass" group="write" password="CHANGE_THIS_WAVEPASS_PASSWORD" comment="WavePass API service account"
    :log info "WavePass: Created 'wavepass' system user."
} else={
    :log info "WavePass: 'wavepass' user already exists."
}

# 2. Enable REST API / HTTP service for WavePass control
/ip/service/enable [find name="www"]
/ip/service/enable [find name="www-ssl"]

# 3. Add Paystack & WavePass domains to Hotspot Walled Garden (Bypass before login)
/ip/hotspot/walled-garden/ip add dst-host="*.paystack.co" action=accept comment="WavePass: Paystack API"
/ip/hotspot/walled-garden/ip add dst-host="*.paystack.com" action=accept comment="WavePass: Paystack Checkout"
/ip/hotspot/walled-garden/ip add dst-host="checkout.paystack.com" action=accept comment="WavePass: Paystack Checkout Host"
/ip/hotspot/walled-garden/ip add dst-host="*.supabase.co" action=accept comment="WavePass: Supabase backend"

# 4. Create Standard Plan User Profiles (1h, 12h, 24h)
/ip/hotspot/user/profile add name="profile_1h" session-timeout=1h keepalive-timeout=2m shared-users=1 status-autorefresh=1m rate-limit="10M/5M" comment="WavePass 1-Hour Profile"
/ip/hotspot/user/profile add name="profile_12h" session-timeout=12h keepalive-timeout=2m shared-users=1 status-autorefresh=1m rate-limit="15M/5M" comment="WavePass 12-Hour Profile"
/ip/hotspot/user/profile add name="profile_1d" session-timeout=1d keepalive-timeout=2m shared-users=1 status-autorefresh=1m rate-limit="20M/10M" comment="WavePass 24-Hour Profile"

:log info "WavePass: Auto-configuration complete! Router is ready for WavePass cloud control."
