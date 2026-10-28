# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting on this
repository (the **Security** tab, then **Report a vulnerability**), and include the Termix version, the plugin
version and the steps to reproduce.

## Scope

This plugin deliberately gives a signed-in Termix user an editor and terminal on a host. These are expected
behaviours, not vulnerabilities:

- code-server runs with `--auth none` on the host's loopback, reachable only through the plugin.
- The editor page is served from the Termix origin (see the README's Security section).

Problems that are in scope include: reaching another user's session, a path or setting that runs commands on the host,
Termix credentials reaching the host, sessions or processes that outlive their owner, and anything that lets
unauthenticated traffic reach code-server.
