# Enable GitHub sign-in for C Atlas

C Atlas uses GitHub to identify visitors and Supabase to store each user's saved repository links. The first successful sign-in creates the user's account. Opening a saved link fetches the current public repository from GitHub.

## Connect GitHub and Supabase

1. Create or select a Supabase project for C Atlas. In **Authentication → Sign In / Providers → GitHub**, copy the callback URL. It has the form `https://<project-ref>.supabase.co/auth/v1/callback`.
2. In **GitHub → Settings → Developer settings → OAuth Apps**, register **C Atlas**. Set the homepage to `https://pconst167.github.io/c-atlas/` and the **Authorization callback URL** to the Supabase callback from step 1. Leave **Enable Device Flow** unchecked.
3. Enable the GitHub provider in Supabase. Enter the GitHub client ID and enter the client secret directly in the provider settings. Save the provider settings and enable new-user signups.
4. In **Supabase → Authentication → URL Configuration**, set the **Site URL** to `https://pconst167.github.io/c-atlas/` and allow that exact URL as a redirect destination, including its trailing slash. [Supabase GitHub provider guide](https://supabase.com/docs/guides/auth/social-sign-in/auth-github) · [Redirect URL guide](https://supabase.com/docs/guides/auth/redirect-urls)

## Enable saved projects

1. Run the saved-projects migration once against the same Supabase project. You can paste the file into the Supabase SQL Editor and run it as one script. [Saved-projects migration](../supabase/migrations/20261125140000_create_saved_projects.sql)
2. In **Integrations → Data API**, ensure the Data API is enabled and `public.c_atlas_projects` is exposed. The migration grants authenticated users access to their own rows. [Supabase Data API guide](https://supabase.com/docs/guides/api/creating-routes)
3. Place `accounts.json` alongside `index.html` in both the source and the published GitHub Pages branch. Replace the sample values with the project's URL and its **publishable** API key from Supabase.

```json
{
  "supabaseUrl": "https://<project-ref>.supabase.co",
  "publishableKey": "sb_publishable_<your-publishable-key>"
}
```

These two values are public browser configuration. Keep the GitHub client secret in Supabase's provider settings and keep privileged database keys out of this file. [Supabase API key guide](https://supabase.com/docs/guides/getting-started/api-keys)

## Verify account isolation

Sign in with GitHub in one browser profile, save a public repository, and sign in again to confirm it reappears. Use a second profile with a different GitHub account and check that its saved list is empty. Save the same repository there, remove it from the second account, and confirm it still appears when you reopen the first account's list.
