(function(){
  // Simple client-side i18n for the single-page UI
  const translations = {
    "en": {
      title: '🌈 Smart Device',
      subtitle: 'Control your light waver',
      login_tab: 'Login',
      signup_tab: 'Sign Up',
      login_email_label: 'Email',
      login_password_label: 'Password',
      sign_in_btn: 'Sign In',
      signup_email_label: 'Email',
      signup_password_label: 'Password (min 6 characters)',
      signup_confirm_label: 'Confirm Password',
      create_account_btn: 'Create Account',
      signup_success: '✓ Account created! You can now log in.',
      not_logged_in: 'Not logged in. Please log in to claim devices.',
      claim_label: 'Claim Code',
      claim_placeholder: 'e.g. ABC-123',
      claim_button: 'Claim Device',
      logout_btn: 'Logout',
      welcome_text: 'Welcome!'
    },
    "ja": {
      title: '🌈 スマートデバイス',
      subtitle: 'ライトウェーバーを操作する',
      login_tab: 'ログイン',
      signup_tab: 'アカウント作成',
      login_email_label: 'メールアドレス',
      login_password_label: 'パスワード',
      sign_in_btn: 'サインイン',
      signup_email_label: 'メールアドレス',
      signup_password_label: 'パスワード（6文字以上）',
      signup_confirm_label: 'パスワード（確認）',
      create_account_btn: 'アカウント作成',
      signup_success: '✓ アカウントを作成しました。ログインできます。',
      not_logged_in: 'ログインしていません。デバイスを紐付けるにはログインしてください。',
      claim_label: 'クレームコード',
      claim_placeholder: '例: ABC-123',
      claim_button: 'デバイスを登録',
      logout_btn: 'ログアウト',
      welcome_text: 'ようこそ！'
    },
    "es": {
      title: '🌈 Dispositivo Inteligente',
      subtitle: 'Controla tu light waver',
      login_tab: 'Iniciar sesión',
      signup_tab: 'Crear cuenta',
      login_email_label: 'Correo',
      login_password_label: 'Contraseña',
      sign_in_btn: 'Entrar',
      signup_email_label: 'Correo',
      signup_password_label: 'Contraseña (mín 6 car.)',
      signup_confirm_label: 'Confirmar contraseña',
      create_account_btn: 'Crear cuenta',
      signup_success: '✓ ¡Cuenta creada! Ahora puedes iniciar sesión.',
      not_logged_in: 'No has iniciado sesión. Inicia sesión para reclamar dispositivos.',
      claim_label: 'Código de registro',
      claim_placeholder: 'p.ej. ABC-123',
      claim_button: 'Registrar dispositivo',
      logout_btn: 'Cerrar sesión',
      welcome_text: '¡Bienvenido!'
    },
    "fr": {
      title: '🌈 Appareil Intelligent',
      subtitle: "Contrôlez votre light waver",
      login_tab: 'Connexion',
      signup_tab: 'S’inscrire',
      login_email_label: 'E‑mail',
      login_password_label: 'Mot de passe',
      sign_in_btn: 'Se connecter',
      signup_email_label: 'E‑mail',
      signup_password_label: 'Mot de passe (min 6 caractères)',
      signup_confirm_label: 'Confirmer le mot de passe',
      create_account_btn: 'Créer un compte',
      signup_success: '✓ Compte créé ! Vous pouvez maintenant vous connecter.',
      not_logged_in: 'Non connecté. Veuillez vous connecter pour enregistrer un appareil.',
      claim_label: 'Code d’enregistrement',
      claim_placeholder: 'ex. ABC-123',
      claim_button: 'Enregistrer l’appareil',
      logout_btn: 'Se déconnecter',
      welcome_text: 'Bienvenue !'
    },
    "de": {
      title: '🌈 Smart Gerät',
      subtitle: 'Steuere deinen Light Waver',
      login_tab: 'Login',
      signup_tab: 'Registrieren',
      login_email_label: 'E‑Mail',
      login_password_label: 'Passwort',
      sign_in_btn: 'Anmelden',
      signup_email_label: 'E‑Mail',
      signup_password_label: 'Passwort (min. 6 Zeichen)',
      signup_confirm_label: 'Passwort bestätigen',
      create_account_btn: 'Konto erstellen',
      signup_success: '✓ Konto erstellt! Du kannst dich jetzt anmelden.',
      not_logged_in: 'Nicht angemeldet. Bitte anmelden, um Geräte zu registrieren.',
      claim_label: 'Claim-Code',
      claim_placeholder: 'z. B. ABC-123',
      claim_button: 'Gerät registrieren',
      logout_btn: 'Abmelden',
      welcome_text: 'Willkommen!'
    },
    "zh-TW": {
      title: '🌈 智慧裝置',
      subtitle: '控制你的 light waver',
      login_tab: '登入',
      signup_tab: '註冊帳號',
      login_email_label: '電子郵件',
      login_password_label: '密碼',
      sign_in_btn: '登入',
      signup_email_label: '電子郵件',
      signup_password_label: '密碼（最少6字）',
      signup_confirm_label: '確認密碼',
      create_account_btn: '建立帳號',
      signup_success: '✓ 帳號建立完成！現在可以登入。',
      not_logged_in: '尚未登入。請登入以綁定裝置。',
      claim_label: '綁定代碼',
      claim_placeholder: '例如 ABC-123',
      claim_button: '綁定裝置',
      logout_btn: '登出',
      welcome_text: '歡迎！'
    },
    "ko": {
      title: '🌈 스마트 디바이스',
      subtitle: '라이트 웨이버를 제어하세요',
      login_tab: '로그인',
      signup_tab: '회원가입',
      login_email_label: '이메일',
      login_password_label: '비밀번호',
      sign_in_btn: '로그인',
      signup_email_label: '이메일',
      signup_password_label: '비밀번호 (최소 6자)',
      signup_confirm_label: '비밀번호 확인',
      create_account_btn: '계정 만들기',
      signup_success: '✓ 계정이 생성되었습니다! 이제 로그인할 수 있습니다.',
      not_logged_in: '로그인되어 있지 않습니다. 기기 등록을 위해 로그인하세요.',
      claim_label: '클레임 코드',
      claim_placeholder: '예: ABC-123',
      claim_button: '기기 등록',
      logout_btn: '로그아웃',
      welcome_text: '환영합니다!'
    }
  };

  function getBrowserLang() {
    const lang = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
    // map zh -> zh-TW fallback; take first two letters for matching
    if (lang.startsWith('zh')) return 'zh-TW';
    if (lang.startsWith('ja')) return 'ja';
    if (lang.startsWith('es')) return 'es';
    if (lang.startsWith('fr')) return 'fr';
    if (lang.startsWith('de')) return 'de';
    if (lang.startsWith('ko')) return 'ko';
    return 'en';
  }

  function t(locale, key) {
    const L = translations[locale] || translations['en'];
    return L[key] || translations['en'][key] || key;
  }

  function applyTranslations(locale) {
    // Header
    document.getElementById('site-title').textContent = t(locale, 'title');
    document.getElementById('site-subtitle').textContent = t(locale, 'subtitle');

    // Tabs
    document.querySelectorAll('.tab-btn')[0].textContent = t(locale, 'login_tab');
    document.querySelectorAll('.tab-btn')[1].textContent = t(locale, 'signup_tab');

    // Labels and buttons
    document.querySelector('label[for="login-email"]').textContent = t(locale, 'login_email_label');
    document.querySelector('label[for="login-password"]').textContent = t(locale, 'login_password_label');
    document.querySelector('#login button[type="submit"]').textContent = t(locale, 'sign_in_btn');

    document.querySelector('label[for="signup-email"]').textContent = t(locale, 'signup_email_label');
    document.querySelector('label[for="signup-password"]').textContent = t(locale, 'signup_password_label');
    document.querySelector('label[for="signup-confirm"]').textContent = t(locale, 'signup_confirm_label');
    document.querySelector('#signup button[type="submit"]').textContent = t(locale, 'create_account_btn');

    // Dashboard
    document.querySelector('label[for="claim-code"]').textContent = t(locale, 'claim_label');
    const claimInput = document.getElementById('claim-code');
    if (claimInput) claimInput.placeholder = t(locale, 'claim_placeholder');
    document.querySelectorAll('.dashboard .btn')[0].textContent = t(locale, 'claim_button');
    document.querySelector('.logout-btn').textContent = t(locale, 'logout_btn');

    // Messages (signup success uses dynamic text in existing script; we expose a helper)
    // store translated success text for UI use
    window.__i18n_signup_success = t(locale, 'signup_success');
    window.__i18n_not_logged_in = t(locale, 'not_logged_in');
    window.__i18n_welcome_text = t(locale, 'welcome_text');
  }

  function initI18n() {
    const select = document.getElementById('lang-select');
    if (!select) return;
    const saved = localStorage.getItem('ui_lang') || getBrowserLang();
    if (translations[saved]) select.value = saved;
    applyTranslations(select.value);

    select.addEventListener('change', () => {
      const v = select.value;
      localStorage.setItem('ui_lang', v);
      applyTranslations(v);
    });

    // Patch existing inline handlers that show messages to use translated strings.
    // For example, signup success: replace text if available
    // Wait until the app's inline JS sets up functions; poll and then override
    setTimeout(() => {
      // If the page code references signup-success element and uses hardcoded text,
      // we cannot easily intercept; but we set window.__i18n_signup_success for usage.
      const signupSuccessEl = document.getElementById('signup-success');
      if (signupSuccessEl && signupSuccessEl.textContent.trim() !== '') {
        // keep existing
      }
    }, 500);
  }

  // expose helper for app inline script to read translated strings
  window.i18n = {
    t: (k) => {
      const lang = localStorage.getItem('ui_lang') || getBrowserLang();
      return t(lang, k);
    },
    init: initI18n
  };

  // initialize on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initI18n);
  } else {
    initI18n();
  }
})();