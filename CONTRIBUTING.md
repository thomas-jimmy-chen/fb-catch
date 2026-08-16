# Contributing to FB Catch | 貢獻指南

Thank you for your interest in contributing to FB Catch!
感謝您有興趣為 FB Catch 做出貢獻！

---

## How to Contribute | 如何貢獻

### Bug Reports | 回報 Bug

Open an [issue](../../issues) with:
- Steps to reproduce | 重現步驟
- Expected vs actual behavior | 預期與實際行為
- Browser version and OS | 瀏覽器版本與作業系統

### Feature Requests | 功能建議

Open an [issue](../../issues) describing the use case and why it would
be valuable. | 開 issue 描述使用場景與價值。

### Security Vulnerabilities | 安全漏洞

**Do NOT open a public issue for security vulnerabilities.**
**安全漏洞請勿開公開 issue。**

Instead, report security issues privately via
[GitHub Security Advisories](../../security/advisories/new) or email
the maintainer directly. We will respond within 7 days and aim to
release a fix within 14 days for critical issues.

請透過 [GitHub Security Advisories](../../security/advisories/new)
或直接 email 維護者回報。我們會在 7 天內回應，重大漏洞 14 天內修復。

### Pull Requests | 提交 PR

1. Fork the repository | Fork 此儲存庫
2. Create a feature branch (`git checkout -b feature/my-change`)
3. Make your changes | 進行修改
4. Sign off every commit (see DCO below) | 每個 commit 都要簽署（見下方 DCO）
5. Ensure no third-party code with incompatible licenses is included |
   確保未包含授權不相容的第三方程式碼
6. Open a pull request against `main` | 對 `main` 開 PR

All PRs require review and approval by the maintainer before merging.
所有 PR 需經維護者審核同意後才會合併。

---

## Developer Certificate of Origin (DCO) | 開發者原創聲明

This project uses the [DCO](https://developercertificate.org/) instead
of a CLA. By signing off your commits, you certify that you have the
right to submit the contribution under the project's license.

本專案採用 DCO（非 CLA）。簽署 commit 即表示您確認有權在本專案授權下
提交該貢獻。

### How to Sign Off | 如何簽署

Add a `Signed-off-by` line to every commit message:

```
git commit -s -m "fix: describe your change"
```

This produces:

```
fix: describe your change

Signed-off-by: Your Name <your.email@example.com>
```

PRs with unsigned commits will not be merged.
未簽署的 commit 不會被合併。

---

## Copyright and License | 著作權與授權

- **You retain copyright** of your contributions.
  您保留您貢獻的著作權。

- By submitting a PR, you grant the project maintainer a **perpetual,
  irrevocable, worldwide, royalty-free license** to use, modify,
  distribute, sublicense, and create derivative works from your
  contribution as part of this project — **including patent rights
  necessary to use the contribution**.
  提交 PR 即表示您授予專案維護者永久、不可撤銷、全球性、免權利金的授權，
  以使用、修改、散布、再授權及基於您的貢獻建立衍生作品作為本專案的
  一部分——**包括使用該貢獻所必要的專利權**。

- If your contribution includes code from third-party sources, you must
  ensure the original license is compatible with this project's license
  and disclose it in your PR description.
  若您的貢獻包含第三方程式碼，您必須確保原始授權與本專案授權相容，
  並在 PR 說明中揭露。

- The project is licensed under the **FB Catch Source Available
  License v1.0** — see [LICENSE](LICENSE) for details.
  本專案採用 **FB Catch 原始碼公開授權 v1.0** — 詳見 [LICENSE](LICENSE)。

---

## Code Style | 程式碼風格

- JavaScript (ES2020+), no build step
- 2-space indentation
- Meaningful variable names in English
- Comments in English or Traditional Chinese (zh-TW)

---

## DCO Full Text | DCO 全文

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.

Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```
