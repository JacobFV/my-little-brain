# Connections, media feedback, and portals

User-authorized continuation: replace Brain Circle with reciprocal portal plugin sessions; make external account connections real; open-file wording; repair silent camera/voice actions. Work in the shared live checkout so the running preview updates.

1. Implement external account connection adapters, local credential handling, provider API boundaries, account UI, and honest OAuth setup errors. Notion and Google are required; use a practical extensible registry for others. Do not register outside apps or deploy.
2. Implement portal plugin runtime and rendering: reciprocal live environment scenes, per-twin messages and plugin context, cancellation when closed, no separate circle UI or turn limit. Preserve old local journals as archived data.
3. Diagnose media actions, fix start/error/progress lifecycle and timeout/cancellation; show errors on the action surface.
4. Integrate Connections, Open a file, portal objects/focused views, mobile controls and styles. Remove Circle from navigation.
5. Run focused behavioral tests, typecheck, production/CF dry-run and browser verification; review changes and push private repository. No deployment.

Ruling: proceed within the user's explicit full-implementation authorization without another design gate. External provider app registration/credentials cannot be invented; provide real configured OAuth and/or supported token paths with actionable missing-configuration states.
