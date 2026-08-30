/* ==========================================================================
   КОНФИГУРАЦИЯ ПРИЛОЖЕНИЯ
   ==========================================================================
   Чтобы включить облачный режим (общая база для двоих):
   1) создайте проект на https://supabase.com
   2) Project Settings → API → скопируйте Project URL и anon key
   3) вставьте их ниже в supabaseUrl / supabaseAnonKey
   4) замените e-mail на настоящие почты участников
   5) выполните schema.sql в SQL-редакторе Supabase (SQL Editor → New query)

   Пока supabaseUrl пуст — сайт работает в демо-режиме на localStorage
   (все данные хранятся только в этом браузере).
   ========================================================================== */

window.APP_CONFIG = {
  // Project URL из Supabase
  supabaseUrl: "https://kvhljkyvdqsmgxersghp.supabase.co",

  // anon key (публичный ключ, его можно оставлять в коде — защищает RLS)
  supabaseAnonKey: "sb_publishable_gan4Va7M2295mElERMOoUA_0u6aLip1",

  // Участники. Почта — это логин. username и initials показываются на сайте.
  // admin: true — расширенные права (фиксировать треки и их количество).
  allowedUsers: [
    { email: "sadrinavera530@gmail.com", username: "киллмиплаг", initials: "к", admin: false },
    { email: "sportgamergd@gmail.com",   username: "Elevator",    initials: "E", admin: true  },
  ],

  // Пароль для ЛОКАЛЬНОГО демо-режима (когда supabaseUrl пуст).
  // В облачном режиме пароли задаются при регистрации на сайте.
  demoPassword: "demo",
};
