# PuTTY test keys

Throwaway keys for `tests/test_ppk.py`, generated with `puttygen` 0.78 (Debian `putty-tools`).
They are not authorized anywhere — never reuse them.

- `<type>-v2.ppk`, `<type>-v3.ppk`: unencrypted, PPK format 2 / 3
- `<type>-v2-enc.ppk`, `<type>-v3-enc.ppk`: encrypted with the passphrase `test-passphrase`
  (format 2: AES + SHA-1 key derivation, format 3: AES + Argon2id)
- `<type>.pub`: the matching OpenSSH public key from `puttygen -O public-openssh`

Types: `ed25519`, `rsa` (2048 bit), `ecdsa` (nistp256).
