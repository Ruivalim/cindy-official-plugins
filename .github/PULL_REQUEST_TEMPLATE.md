<!-- Title: <type>(<plugin-directory>): <short description>
标题示例：fix(qq-mail): validate the move result
Describe only applicable changes. CI checks versions, DCO, manifests, locales and
packages; do not copy its output or tick unrelated checklists.
只写适用内容。版本、DCO、清单、语言资源和包结构由 CI 检查，不必抄结果或勾无关清单。
-->

## What and why / 改了什么、为什么

<!-- User-facing outcome, affected plugin(s), issue if any.
用户可见结果、涉及插件；有 issue 请关联。 -->

## Impact / 影响

<!-- Mention changed behavior or tool contracts, data destinations, fees,
permissions (including Manifest-v3 direct capability fields), compatibility,
dependencies or packaging ONLY when applicable.
No such changes? Say "None / 无". Keep declarations/manuals/locales consistent.
仅在涉及时说明行为/工具契约、数据去向、费用、权限（含 Manifest-v3 直接能力字段）、
兼容性、依赖或打包变化。
不涉及时写“无”；保持声明、手册与语言资源一致。 -->

## Verification / 验证

<!-- Actual commands and results; runtime version/environment, exercised paths
and remaining gaps. Link to existing comments/artifacts instead of copying hashes
already provided by CI. Authors or maintainers can supply evidence.
实际命令和结果；运行版本/环境、测试场景与未测项。可链接现有评论/产物，不必重复
抄写 CI 已提供的哈希。作者或维护者均可提供验证。

Existing evidence: identify the tested version and explain why changes since it
leave the relevant paths unaffected. Do not claim the latest package was tested
if it was not. Changed behavior still needs its applicable runtime verification.
沿用证据时注明已测版本，以及此后完整差异为何不影响相应路径；旧包实测不等于
新包已测。行为改动仍需对应的真实运行验证。无需固定的“实机已测”勾选项。

Review contract: .greptile/rules.md → 运行验证与证据复用
-->

## Third-party OAuth scopes / 第三方 OAuth 授权范围

<!-- Tick one. This covers any change that expands the scopes Cindy's shared
OAuth app (or a similar platform grant) requests, including a plugin that
depends on a new host authorization. If it applies, list the scopes, why, and
whether the plugin or the host requests them. When the host does, name that
grant, whether the platform has approved it, and whether a host release
contains it. Do not merge until that is done. Plan scopes from the plugin and
the host together; do not request unused ones. Host-side changes follow the
same rule in makecindy/cindy; do not restate it here.
勾一项。凡扩大 Cindy 共用 OAuth 应用（或同类平台授权）申请范围的改动都算，
包括插件依赖宿主新增的授权。有则列出 scope、为什么要、由插件还是宿主申请。
由宿主申请时写明依赖哪项宿主授权、平台是否已批准、宿主是否已发布；没有就先
不合。按插件和宿主的整体需求一次规划，用不上的不要申请。宿主侧改动由主仓
makecindy/cindy 的同一条规则管，这里不复述。 -->

- [ ] Does not expand scopes requested by Cindy's shared OAuth app (or an
      equivalent platform grant), and does not depend on a new host authorization.
      未扩大 Cindy 共用 OAuth 应用（或同类平台授权）的申请范围，也不依赖宿主新增授权。
- [ ] Does. Scopes, why, who requests them; if the host does, the host grant,
      platform approval, and host release:
      有。scope、为什么要、由谁申请；若由宿主申请：宿主授权、平台是否已批准、宿主是否已发布：

## Decisions, if applicable / 相关决定（适用时）

<!-- For a new plugin or an audience change, state which tier applies:
`all`, opt-in `{ "emails": [] }`, or not accepted. A match needs no maintainer
approval. Link the maintainers' explicit decision only for a real boundary
expansion: permission, credential, or publish-trust widening; undisclosed
network access; renaming or deleting a published plugin.
新增插件或改 audience 时写明落在哪一档：`all`、自选 `{ "emails": [] }`，或
不予接受。符合标准不需要维护者批准。只有真实边界扩大才链接维护者的明确决定：
权限、凭证或发布信任扩大，未声明的网络访问，以及重命名或删除已发布插件。 -->
