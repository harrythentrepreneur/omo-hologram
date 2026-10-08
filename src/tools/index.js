// ── Data (CEO-brief, orders, customers, ads, profile) ────────────────
import * as profile from './data/profile.js';
import * as orders from './data/orders.js';
import * as ads from './data/ads.js';
import * as customers from './data/customers.js';
import * as products from './data/products.js';
import * as snapshot from './data/snapshot.js';
import * as calendar from './data/calendar.js';
import * as tasks from './data/tasks.js';

// ── Viz / cards (renderers + pane management) ───────────────────────
import * as viz from './viz/viz.js';
import * as statusTool from './viz/status.js';
import * as mediaTool from './viz/media.js';
import * as notify from './viz/notify.js';
import * as qr from './viz/qr.js';
import * as mapTool from './viz/map.js';
import * as timerTool from './viz/timer.js';
import * as nowPlaying from './viz/now_playing.js';
import * as paneTool from './viz/show_pane.js';
import * as showRawTool from './viz/show_raw.js';

// ── Google productivity (Gmail + Docs) ──────────────────────────────
import * as gmailRead from './google/gmail_read.js';
import * as gmailSend from './google/gmail_send.js';
import * as draftEmailReply from './google/draft_email_reply.js';
import * as sendEmailReply from './google/send_email_reply.js';
import * as discardEmailReply from './google/discard_email_reply.js';
import * as googleDocs from './google/google_docs.js';

// ── GitHub ─────────────────────────────────────────────────────────
import * as prs from './github/prs.js';
import * as ciStatus from './github/ci_status.js';
import * as repoActivity from './github/repo_activity.js';
import * as issues from './github/issues.js';
import * as ghNotifications from './github/gh_notifications.js';
import * as prComment from './github/pr_comment.js';
import * as prMerge from './github/pr_merge.js';
import * as issueClose from './github/issue_close.js';

// ── Agent dispatch & control ───────────────────────────────────────
import * as agentTool from './agents/agent.js';
import * as spawnAgentTask from './agents/spawn_agent_task.js';
import * as continueAgentTask from './agents/continue_agent_task.js';
import * as agentStatus from './agents/agent_status.js';
import * as showAgentScreen from './agents/show_agent_screen.js';
import * as showAgentTab from './agents/show_agent_tab.js';
import * as showAgentTerminalsTool from './agents/show_agent_terminals.js';
import * as showAgentTerminalTool from './agents/show_agent_terminal.js';
import * as closeAgentScreen from './agents/close_agent_screen.js';
import * as closeAgent from './agents/close_agent.js';
import * as stopAgent from './agents/stop_agent.js';
import * as stopAllAgents from './agents/stop_all_agents.js';
import * as reapAgentNow from './agents/reap_agent_now.js';
import * as getAgentScreenContext from './agents/get_agent_screen_context.js';
import * as approveAgent from './agents/approve_agent.js';
import * as featherFocus from './agents/feather_focus.js';
import * as featherControl from './agents/feather_control.js';
import * as claudePty from './agents/claude_pty.js';
import * as claudeRelaunch from './agents/claude_relaunch.js';

// ── AI coding loop (worktree review / accept / discard) ────────────
import * as peekAgentDiff from './coding/peek_agent_diff.js';
import * as acceptAgentWork from './coding/accept_agent_work.js';
import * as discardAgentWork from './coding/discard_agent_work.js';
import * as syncUserEdits from './coding/sync_user_edits.js';
import * as resolveAgentConflict from './coding/resolve_agent_conflict.js';
import * as listWorkspaces from './coding/list_workspaces.js';
import * as describeChanges from './coding/describe_changes.js';

// ── Preview surface (browse / interact / navigate) ─────────────────
import * as previewTool from './preview/show_preview.js';
import * as previewNav from './preview/preview_nav.js';
import * as doPreview from './preview/do_preview.js';
import * as addPreviewBridge from './preview/add_preview_bridge.js';

// ── Grounded reasoning (hq stream, web search, sub-agents) ─────────
import * as hqQuery from './research/hq_query.js';
import * as webSearch from './research/web_search.js';
import * as spawnAgent from './research/spawn_agent.js';
import * as getScreenContext from './research/get_screen_context.js';
import * as openHqDetail from './research/open_hq_detail.js';
import * as metaDashboardCommand from './research/meta_dashboard_command.js';

// ── UI control ─────────────────────────────────────────────────────
import * as setUiLanguage from './ui/set_ui_language.js';
import * as approve from './ui/approve.js';

// ── Hermes voice surface (wraps the `hermes` CLI) ──────────────────
import * as hermesSkills from './hermes/skills.js';
import * as hermesSessions from './hermes/sessions.js';
import * as hermesMemory from './hermes/memory.js';
import * as hermesCheckpoints from './hermes/checkpoints.js';
import * as hermesCron from './hermes/cron.js';
import * as hermesInsights from './hermes/insights.js';
import * as hermesProfile from './hermes/profile.js';
import * as hermesPlugins from './hermes/plugins.js';
import * as hermesMcp from './hermes/mcp.js';
import * as hermesWebhook from './hermes/webhook.js';
import * as hermesKanban from './hermes/kanban.js';
import * as hermesHooks from './hermes/hooks.js';
import * as hermesConfig from './hermes/config.js';
import * as hermesModel from './hermes/model.js';
import * as hermesTools from './hermes/tools.js';
import * as hermesHealth from './hermes/health.js';
import * as hermesBackup from './hermes/backups.js';
import * as hermesCurator from './hermes/curator.js';
import * as hermesPairing from './hermes/pairing.js';
import * as hermesLifecycle from './hermes/lifecycle.js';
import * as hermesGateway from './hermes/gateway.js';
import * as hermesAuth from './hermes/auth.js';

const REGISTRY = {
  get_user_profile:      { definition: profile.definition,            run: profile.run },
  get_recent_orders:     { definition: orders.recentDefinition,       run: orders.runRecent },
  get_orders_timeseries: { definition: orders.timeseriesDefinition,   run: orders.runTimeseries },
  get_revenue_breakdown: { definition: orders.breakdownDefinition,    run: orders.runBreakdown },
  get_channel_mix:       { definition: orders.channelMixDefinition,   run: orders.runChannelMix },
  get_ads_performance:   { definition: ads.performanceDefinition,     run: ads.runPerformance },
  get_customer_stats:    { definition: customers.statsDefinition,     run: customers.runStats },
  get_top_products:      { definition: products.topDefinition,        run: products.runTop },
  get_daily_snapshot:    { definition: snapshot.definition,           run: snapshot.run },
  render_viz:            { definition: viz.definition,                run: viz.run },
  highlight_viz:         { definition: viz.highlightDefinition,       run: viz.runHighlight },
  dismiss_viz:           { definition: viz.dismissDefinition,         run: viz.runDismiss },
  render_status:         { definition: statusTool.definition,         run: statusTool.run },
  show_media:            { definition: mediaTool.definition,          run: mediaTool.run },
  introduce_agent:       { definition: agentTool.definition,          run: agentTool.run },
  show_pane:             { definition: paneTool.definition,           run: paneTool.run },
  show_agent_terminals:  { definition: showAgentTerminalsTool.definition, run: showAgentTerminalsTool.run },
  // Singular: open monitor for ONE agent + flip to @live tab in one call.
  // Distinct from show_agent_terminals (plural, war-room split view).
  show_agent_terminal:   { definition: showAgentTerminalTool.definition,  run: showAgentTerminalTool.run },
  show_preview:          { definition: previewTool.definition,        run: previewTool.run },
  navigate_preview:      { definition: previewNav.navigateDefinition, run: previewNav.runNavigate },
  interact_preview:      { definition: previewNav.interactDefinition, run: previewNav.runInteract },
  scroll_preview:        { definition: previewNav.scrollDefinition,   run: previewNav.runScroll },
  describe_preview:      { definition: previewNav.describeDefinition, run: previewNav.runDescribe },
  do_preview:            { definition: doPreview.definition,          run: doPreview.run },
  add_preview_bridge:    { definition: addPreviewBridge.definition,   run: addPreviewBridge.run },
  describe_changes:      { definition: describeChanges.definition,    run: describeChanges.run },
  dismiss_pane:          { definition: paneTool.dismissDefinition,    run: paneTool.runDismiss },
  show_raw_data:         { definition: showRawTool.definition,        run: showRawTool.run },
  send_email:            { definition: gmailSend.definition,          run: gmailSend.run },
  draft_email_reply:     { definition: draftEmailReply.definition,    run: draftEmailReply.run },
  send_email_reply:      { definition: sendEmailReply.definition,     run: sendEmailReply.run },
  discard_email_reply:   { definition: discardEmailReply.definition,  run: discardEmailReply.run },
  spawn_agent_task:      { definition: spawnAgentTask.definition,     run: spawnAgentTask.run },
  feather_focus:         { definition: featherFocus.definition,       run: featherFocus.run },
  feather_control:       { definition: featherControl.definition,     run: featherControl.run },
  approve_agent:         { definition: approveAgent.definition,       run: approveAgent.run },
  close_agent:           { definition: closeAgent.definition,         run: closeAgent.run },
  agent_status:          { definition: agentStatus.definition,        run: agentStatus.run },
  show_agent_screen:     { definition: showAgentScreen.definition,    run: showAgentScreen.run },
  show_agent_tab:        { definition: showAgentTab.definition,       run: showAgentTab.run },
  close_agent_screen:    { definition: closeAgentScreen.definition,   run: closeAgentScreen.run },
  stop_agent:            { definition: stopAgent.definition,          run: stopAgent.run },
  stop_all_agents:       { definition: stopAllAgents.definition,      run: stopAllAgents.run },
  get_agent_screen_context: { definition: getAgentScreenContext.definition, run: getAgentScreenContext.run },
  continue_agent_task:   { definition: continueAgentTask.definition,   run: continueAgentTask.run },

  // Interactive Claude Code PTY — type into the agent's live terminal
  // by voice. See src/runtimes/claude_pty.js + the /squad @live tab.
  claude_send_text:        { definition: claudePty.sendTextDefinition,    run: claudePty.runSendText },
  claude_send_keys:        { definition: claudePty.sendKeysDefinition,    run: claudePty.runSendKeys },
  claude_send_signal:      { definition: claudePty.sendSignalDefinition,  run: claudePty.runSendSignal },
  claude_slash:            { definition: claudePty.slashDefinition,       run: claudePty.runSlash },
  claude_relaunch_session: { definition: claudeRelaunch.definition,       run: claudeRelaunch.run },

  // Runtime-agnostic aliases — same implementation, neutral name. Voice
  // should reach for these by default; the runtime is resolved by the
  // agent's identity, not by tool name.
  agent_send_text:         { definition: claudePty.agentSendTextDefinition,   run: claudePty.runAgentSendText },
  agent_send_keys:         { definition: claudePty.agentSendKeysDefinition,   run: claudePty.runAgentSendKeys },
  agent_send_signal:       { definition: claudePty.agentSendSignalDefinition, run: claudePty.runAgentSendSignal },
  agent_slash:             { definition: claudePty.agentSlashDefinition,      run: claudePty.runAgentSlash },

  // The "AI coding loop" tools — review, ship, scrap, hand-off in the
  // user's main checkout. peek = read-only preview; accept = git apply
  // onto parent repo; discard = reset worktree; sync = copy user's
  // dirty edits INTO worktree before dispatch.
  peek_agent_diff:       { definition: peekAgentDiff.definition,       run: peekAgentDiff.run },
  accept_agent_work:     { definition: acceptAgentWork.definition,     run: acceptAgentWork.run },
  discard_agent_work:    { definition: discardAgentWork.definition,    run: discardAgentWork.run },
  sync_user_edits:       { definition: syncUserEdits.definition,       run: syncUserEdits.run },
  resolve_agent_conflict:{ definition: resolveAgentConflict.definition, run: resolveAgentConflict.run },
  reap_agent_now:        { definition: reapAgentNow.definition,          run: reapAgentNow.run },
  list_workspaces:       { definition: listWorkspaces.definition,        run: listWorkspaces.run },

  // Inbox
  get_inbox_recent:      { definition: gmailRead.inboxRecentDefinition, run: gmailRead.runInboxRecent },
  get_email_thread:      { definition: gmailRead.threadDefinition,      run: gmailRead.runThread },

  // Google Docs
  create_google_doc:     { definition: googleDocs.createDefinition,     run: googleDocs.runCreate },
  append_to_google_doc:  { definition: googleDocs.appendDefinition,     run: googleDocs.runAppend },
  read_google_doc:       { definition: googleDocs.readDefinition,       run: googleDocs.runRead },

  // Calendar
  get_next_event:        { definition: calendar.nextEventDefinition,      run: calendar.runNextEvent },
  get_agenda_today:      { definition: calendar.agendaTodayDefinition,    run: calendar.runAgendaToday },
  get_upcoming_events:   { definition: calendar.upcomingEventsDefinition, run: calendar.runUpcomingEvents },

  // Tasks
  get_tasks:             { definition: tasks.getTasksDefinition,      run: tasks.runGetTasks },
  add_task:              { definition: tasks.addTaskDefinition,       run: tasks.runAddTask },
  complete_task:         { definition: tasks.completeTaskDefinition,  run: tasks.runCompleteTask },

  // Primitives (notification pill, QR, map, timer, now-playing, approval dial)
  render_notification:   { definition: notify.definition,             run: notify.run },
  show_qr:               { definition: qr.definition,                 run: qr.run },
  show_map:              { definition: mapTool.definition,            run: mapTool.run },
  render_timer:          { definition: timerTool.definition,          run: timerTool.run },
  render_now_playing:    { definition: nowPlaying.definition,         run: nowPlaying.run },
  request_approval:      { definition: approve.definition,            run: approve.run },

  // Grounded-reasoning / research
  hq_query:              { definition: hqQuery.definition,            run: hqQuery.run },
  web_search:            { definition: webSearch.definition,          run: webSearch.run },
  spawn_research_agent:  { definition: spawnAgent.definition,         run: spawnAgent.run },

  // Screen awareness — what is the user looking at / drive the UI by voice
  get_screen_context:    { definition: getScreenContext.definition,   run: getScreenContext.run },
  open_hq_detail:        { definition: openHqDetail.definition,       run: openHqDetail.run },
  meta_dashboard_command:{ definition: metaDashboardCommand.definition, run: metaDashboardCommand.run },
  set_ui_language:       { definition: setUiLanguage.definition,      run: setUiLanguage.run },

  // GitHub — read tools
  list_prs:              { definition: prs.definition,                run: prs.run },
  get_pr:                { definition: prs.detailDefinition,          run: prs.runDetail },
  list_ci_runs:          { definition: ciStatus.definition,           run: ciStatus.run },
  list_repo_activity:    { definition: repoActivity.definition,       run: repoActivity.run },
  list_issues:           { definition: issues.definition,             run: issues.run },
  list_gh_notifications: { definition: ghNotifications.definition,    run: ghNotifications.run },

  // GitHub — actions (gate behind request_approval per persona)
  post_pr_comment:       { definition: prComment.definition,          run: prComment.run },
  merge_pr:              { definition: prMerge.definition,            run: prMerge.run },
  close_issue:           { definition: issueClose.definition,         run: issueClose.run },

  // ─── Hermes voice surface (skills, sessions, memory, checkpoints) ───
  // These wrap Hermes CLI subcommands so voice can install skills, list
  // sessions, inspect memory, manage checkpoints. See src/tools/hermes_*.js.
  hermes_skills_search:       { definition: hermesSkills.searchDefinition,    run: hermesSkills.runHermesSkillsSearch },
  hermes_skills_install:      { definition: hermesSkills.installDefinition,   run: hermesSkills.runHermesSkillsInstall },
  hermes_skills_list:         { definition: hermesSkills.listDefinition,      run: hermesSkills.runHermesSkillsList },
  hermes_skills_inspect:      { definition: hermesSkills.inspectDefinition,   run: hermesSkills.runHermesSkillsInspect },
  hermes_skills_uninstall:    { definition: hermesSkills.uninstallDefinition, run: hermesSkills.runHermesSkillsUninstall },

  hermes_sessions_list:       { definition: hermesSessions.listDefinition,   run: hermesSessions.runHermesSessionsList },
  hermes_sessions_rename:     { definition: hermesSessions.renameDefinition, run: hermesSessions.runHermesSessionsRename },
  hermes_sessions_export:     { definition: hermesSessions.exportDefinition, run: hermesSessions.runHermesSessionsExport },
  hermes_sessions_delete:     { definition: hermesSessions.deleteDefinition, run: hermesSessions.runHermesSessionsDelete },

  hermes_memory_show:             { definition: hermesMemory.showDefinition,           run: hermesMemory.runHermesMemoryShow },
  hermes_memory_provider_status:  { definition: hermesMemory.providerStatusDefinition, run: hermesMemory.runHermesMemoryProviderStatus },

  hermes_checkpoints_list:    { definition: hermesCheckpoints.listDefinition,  run: hermesCheckpoints.runHermesCheckpointsList },
  hermes_checkpoints_prune:   { definition: hermesCheckpoints.pruneDefinition, run: hermesCheckpoints.runHermesCheckpointsPrune },
  hermes_checkpoints_clear:   { definition: hermesCheckpoints.clearDefinition, run: hermesCheckpoints.runHermesCheckpointsClear },

  // Hermes cron — recurring agent jobs scheduled by voice.
  hermes_cron_list:           { definition: hermesCron.listDefinition,        run: hermesCron.runList },
  hermes_cron_create:         { definition: hermesCron.createDefinition,      run: hermesCron.runCreate },
  hermes_cron_pause:          { definition: hermesCron.pauseDefinition,       run: hermesCron.runPause },
  hermes_cron_resume:         { definition: hermesCron.resumeDefinition,      run: hermesCron.runResume },
  hermes_cron_run_now:        { definition: hermesCron.runOnceDefinition,     run: hermesCron.runRunNow },
  hermes_cron_remove:         { definition: hermesCron.removeDefinition,      run: hermesCron.runRemove },
  hermes_cron_status:         { definition: hermesCron.statusDefinition,      run: hermesCron.runStatus },

  // Hermes insights — usage / cost / tool patterns.
  hermes_insights:            { definition: hermesInsights.definition,        run: hermesInsights.run },

  // Hermes profile — switch isolated config bundles.
  hermes_profile_list:        { definition: hermesProfile.listDefinition,     run: hermesProfile.runList },
  hermes_profile_use:         { definition: hermesProfile.useDefinition,      run: hermesProfile.runUse },
  hermes_profile_show:        { definition: hermesProfile.showDefinition,     run: hermesProfile.runShow },

  // Hermes plugins — extend the Hermes runtime itself.
  hermes_plugins_list:        { definition: hermesPlugins.listDefinition,     run: hermesPlugins.runList },
  hermes_plugins_install:     { definition: hermesPlugins.installDefinition,  run: hermesPlugins.runInstall },
  hermes_plugins_update:      { definition: hermesPlugins.updateDefinition,   run: hermesPlugins.runUpdate },
  hermes_plugins_remove:      { definition: hermesPlugins.removeDefinition,   run: hermesPlugins.runRemove },
  hermes_plugins_enable:      { definition: hermesPlugins.enableDefinition,   run: hermesPlugins.runEnable },
  hermes_plugins_disable:     { definition: hermesPlugins.disableDefinition,  run: hermesPlugins.runDisable },

  // Hermes MCP — connect / list / test other MCP servers for the Hermes runtime.
  hermes_mcp_list:            { definition: hermesMcp.listDefinition,         run: hermesMcp.runHermesMcpList },
  hermes_mcp_add:             { definition: hermesMcp.addDefinition,          run: hermesMcp.runHermesMcpAdd },
  hermes_mcp_remove:          { definition: hermesMcp.removeDefinition,       run: hermesMcp.runHermesMcpRemove },
  hermes_mcp_test:            { definition: hermesMcp.testDefinition,         run: hermesMcp.runHermesMcpTest },
  hermes_mcp_configure:       { definition: hermesMcp.configureDefinition,    run: hermesMcp.runHermesMcpConfigure },

  // Hermes webhook — dynamic webhook subscriptions.
  hermes_webhook_list:        { definition: hermesWebhook.listDefinition,      run: hermesWebhook.runHermesWebhookList },
  hermes_webhook_subscribe:   { definition: hermesWebhook.subscribeDefinition, run: hermesWebhook.runHermesWebhookSubscribe },
  hermes_webhook_remove:      { definition: hermesWebhook.removeDefinition,    run: hermesWebhook.runHermesWebhookRemove },
  hermes_webhook_test:        { definition: hermesWebhook.testDefinition,      run: hermesWebhook.runHermesWebhookTest },

  // Hermes kanban — multi-profile collaboration board.
  hermes_kanban_list:         { definition: hermesKanban.listDefinition,       run: hermesKanban.runHermesKanbanList },
  hermes_kanban_show:         { definition: hermesKanban.showDefinition,       run: hermesKanban.runHermesKanbanShow },
  hermes_kanban_create:       { definition: hermesKanban.createDefinition,     run: hermesKanban.runHermesKanbanCreate },
  hermes_kanban_comment:      { definition: hermesKanban.commentDefinition,    run: hermesKanban.runHermesKanbanComment },
  hermes_kanban_complete:     { definition: hermesKanban.completeDefinition,   run: hermesKanban.runHermesKanbanComplete },
  hermes_kanban_block:        { definition: hermesKanban.blockDefinition,      run: hermesKanban.runHermesKanbanBlock },
  hermes_kanban_unblock:      { definition: hermesKanban.unblockDefinition,    run: hermesKanban.runHermesKanbanUnblock },
  hermes_kanban_archive:      { definition: hermesKanban.archiveDefinition,    run: hermesKanban.runHermesKanbanArchive },
  hermes_kanban_assign:       { definition: hermesKanban.assignDefinition,     run: hermesKanban.runHermesKanbanAssign },
  hermes_kanban_assignees:    { definition: hermesKanban.assigneesDefinition,  run: hermesKanban.runHermesKanbanAssignees },
  hermes_kanban_stats:        { definition: hermesKanban.statsDefinition,      run: hermesKanban.runHermesKanbanStats },
  hermes_kanban_boards_list:  { definition: hermesKanban.boardsListDefinition, run: hermesKanban.runHermesKanbanBoardsList },

  // Hermes hooks — shell-script hooks (read + revoke consent).
  hermes_hooks_list:          { definition: hermesHooks.listDefinition,        run: hermesHooks.runHermesHooksList },
  hermes_hooks_inspect:       { definition: hermesHooks.inspectDefinition,     run: hermesHooks.runHermesHooksInspect },
  hermes_hooks_doctor:        { definition: hermesHooks.doctorDefinition,      run: hermesHooks.runHermesHooksDoctor },
  hermes_hooks_revoke:        { definition: hermesHooks.revokeDefinition,      run: hermesHooks.runHermesHooksRevoke },

  // Hermes config — read + set config keys.
  hermes_config_show:         { definition: hermesConfig.showDefinition,       run: hermesConfig.runShow },
  hermes_config_path:         { definition: hermesConfig.pathDefinition,       run: hermesConfig.runPath },
  hermes_config_check:        { definition: hermesConfig.checkDefinition,      run: hermesConfig.runCheck },
  hermes_config_set:          { definition: hermesConfig.setDefinition,        run: hermesConfig.runSet },

  // Hermes model — default model + fallback chain.
  hermes_model_show:          { definition: hermesModel.showDefinition,        run: hermesModel.runShow },
  hermes_model_set:           { definition: hermesModel.setDefinition,         run: hermesModel.runSet },
  hermes_fallback_list:       { definition: hermesModel.fallbackListDefinition,  run: hermesModel.runFallbackList },
  hermes_fallback_clear:      { definition: hermesModel.fallbackClearDefinition, run: hermesModel.runFallbackClear },

  // Hermes tools — per-platform tool enablement.
  hermes_tools_list:          { definition: hermesTools.listDefinition,        run: hermesTools.runList },
  hermes_tools_enable:        { definition: hermesTools.enableDefinition,      run: hermesTools.runEnable },
  hermes_tools_disable:       { definition: hermesTools.disableDefinition,     run: hermesTools.runDisable },

  // Hermes health — status / doctor / logs.
  hermes_status:              { definition: hermesHealth.statusDefinition,     run: hermesHealth.runHermesStatus },
  hermes_doctor:              { definition: hermesHealth.doctorDefinition,     run: hermesHealth.runHermesDoctor },
  hermes_logs:                { definition: hermesHealth.logsDefinition,       run: hermesHealth.runHermesLogs },

  // Hermes backup / debug / dump — disaster recovery + support bundles.
  hermes_backup_create:       { definition: hermesBackup.createDefinition,     run: hermesBackup.runHermesBackupCreate },
  hermes_backup_list:         { definition: hermesBackup.listDefinition,       run: hermesBackup.runHermesBackupList },
  hermes_backup_restore:      { definition: hermesBackup.restoreDefinition,    run: hermesBackup.runHermesBackupRestore },
  hermes_dump_setup:          { definition: hermesBackup.dumpDefinition,       run: hermesBackup.runHermesDumpSetup },
  hermes_debug_logs:          { definition: hermesBackup.debugDefinition,      run: hermesBackup.runHermesDebugLogs },

  // Hermes curator — background skill maintenance.
  hermes_curator_status:      { definition: hermesCurator.statusDefinition,    run: hermesCurator.runHermesCuratorStatus },
  hermes_curator_run:         { definition: hermesCurator.runDefinition,       run: hermesCurator.runHermesCuratorRun },
  hermes_curator_pause:       { definition: hermesCurator.pauseDefinition,     run: hermesCurator.runHermesCuratorPause },
  hermes_curator_resume:      { definition: hermesCurator.resumeDefinition,    run: hermesCurator.runHermesCuratorResume },
  hermes_curator_pin:         { definition: hermesCurator.pinDefinition,       run: hermesCurator.runHermesCuratorPin },

  // Hermes pairing — DM auth (telegram/discord/etc).
  hermes_pairing_list:        { definition: hermesPairing.listDefinition,         run: hermesPairing.runHermesPairingList },
  hermes_pairing_approve:     { definition: hermesPairing.approveDefinition,      run: hermesPairing.runHermesPairingApprove },
  hermes_pairing_revoke:      { definition: hermesPairing.revokeDefinition,       run: hermesPairing.runHermesPairingRevoke },
  hermes_pairing_clear_pending: { definition: hermesPairing.clearPendingDefinition, run: hermesPairing.runHermesPairingClearPending },

  // Hermes lifecycle — version + update.
  hermes_version:             { definition: hermesLifecycle.versionDefinition,       run: hermesLifecycle.runHermesVersion },
  hermes_update_check:        { definition: hermesLifecycle.updateCheckDefinition,   run: hermesLifecycle.runHermesUpdateCheck },
  hermes_update_install:      { definition: hermesLifecycle.updateInstallDefinition, run: hermesLifecycle.runHermesUpdateInstall },

  // Hermes gateway — telegram/discord/whatsapp messaging bridge service.
  hermes_gateway_status:      { definition: hermesGateway.statusDefinition,    run: hermesGateway.runStatus },
  hermes_gateway_list:        { definition: hermesGateway.listDefinition,      run: hermesGateway.runList },
  hermes_gateway_start:       { definition: hermesGateway.startDefinition,     run: hermesGateway.runStart },
  hermes_gateway_stop:        { definition: hermesGateway.stopDefinition,      run: hermesGateway.runStop },
  hermes_gateway_restart:     { definition: hermesGateway.restartDefinition,   run: hermesGateway.runRestart },

  // Hermes auth — pooled provider credentials.
  hermes_auth_list:           { definition: hermesAuth.listDefinition,         run: hermesAuth.runList },
  hermes_auth_status:         { definition: hermesAuth.statusDefinition,       run: hermesAuth.runStatus },
  hermes_auth_remove:         { definition: hermesAuth.removeDefinition,       run: hermesAuth.runRemove },
  hermes_auth_reset:          { definition: hermesAuth.resetDefinition,        run: hermesAuth.runReset },
  hermes_auth_logout:         { definition: hermesAuth.logoutDefinition,       run: hermesAuth.runLogout },
};

// Re-exported for external inspection (e.g. boot-time sanity checks).
export { REGISTRY };

export const TOOLS = Object.values(REGISTRY).map((t) => t.definition);

// Gemini wants function declarations without the OpenAI `{ type: 'function', ... }` wrapper.
export const GEMINI_FUNCTION_DECLARATIONS = TOOLS.map(({ type, ...rest }) => rest);

export const TOOL_NAMES = Object.keys(REGISTRY);

const AUTO_VIZ = Object.freeze({
  get_user_profile:      { intent: 'User profile',              chart_type: 'profile_card',      size: 'wide' },
  get_recent_orders:     { intent: 'Recent orders',             chart_type: 'timeline',          size: 'wide' },
  get_orders_timeseries: { intent: 'Revenue trend',             chart_type: 'line',              size: 'wide' },
  get_revenue_breakdown: { intent: 'Revenue breakdown',         chart_type: 'bar',               size: 'wide' },
  get_channel_mix:       { intent: 'Channel mix',               chart_type: 'donut',             size: 'square' },
  get_ads_performance:   { intent: 'Ads performance',           chart_type: 'hbar_rank',         size: 'wide' },
  get_customer_stats:    { intent: 'Customer stats',            chart_type: 'kpi_grid',          size: 'wide' },
  get_top_products:      { intent: 'Top products',              chart_type: 'hbar_rank',         size: 'wide' },
  get_daily_snapshot:    { intent: 'Daily brief',               chart_type: 'daily_brief',       size: 'wide' },

  get_inbox_recent:      { intent: 'Inbox',                     chart_type: 'email_card',        size: 'wide' },
  get_email_thread:      { intent: 'Email thread',              chart_type: 'email_thread',      size: 'wide' },

  read_google_doc:       { intent: 'Google Doc',                chart_type: 'article_card',      size: 'wide' },

  get_next_event:        { intent: 'Next calendar event',       chart_type: 'event_card',        size: 'wide' },
  get_agenda_today:      { intent: 'Today agenda',              chart_type: 'agenda_card',       size: 'wide' },
  get_upcoming_events:   { intent: 'Upcoming agenda',           chart_type: 'agenda_card',       size: 'wide' },

  get_tasks:             { intent: 'Tasks',                     chart_type: 'checklist_card',    size: 'wide' },

  hq_query:              { intent: 'Live activity',             chart_type: null,                size: 'wide' },

  list_prs:              { intent: 'Pull requests',             chart_type: 'notification_card', size: 'wide' },
  get_pr:                { intent: 'Pull request',              chart_type: 'pr_card',           size: 'wide' },
  list_ci_runs:          { intent: 'CI runs',                   chart_type: 'timeline',          size: 'wide' },
  list_repo_activity:    { intent: 'Repo activity',             chart_type: 'timeline',          size: 'wide' },
  list_issues:           { intent: 'Issues',                    chart_type: 'notification_card', size: 'wide' },
  list_gh_notifications: { intent: 'GitHub notifications',      chart_type: 'notification_card', size: 'wide' },
});

function safeDatasetId(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.error || result.viz_id || result.projectable_id || result.auto_viz_id) return null;
  const id = result.id;
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  return trimmed ? trimmed : null;
}

function autoVizSpec(name, result) {
  const base = AUTO_VIZ[name];
  if (!base) return null;
  const spec = { ...base };

  // hq_query and similar tools sometimes tell us the shape-matched widget
  // in their result. Prefer that over a generic default, but keep the
  // qualitative intent number-free so viz.js's anti-hallucination guard
  // remains meaningful.
  if (!spec.chart_type && typeof result?.kind === 'string') {
    const kind = result.kind.toLowerCase();
    if (kind.includes('gmail') || kind.includes('email')) spec.chart_type = 'email_thread';
    else if (kind.includes('stripe') || kind.includes('meta') || kind.includes('timeline')) spec.chart_type = 'timeline';
    else if (kind.includes('task')) spec.chart_type = 'checklist_card';
  }

  return spec;
}

async function attachAutoViz(name, result) {
  const datasetId = safeDatasetId(result);
  const spec = datasetId ? autoVizSpec(name, result) : null;
  if (!spec) return result;

  const args = {
    intent: spec.intent,
    data_refs: [datasetId],
    size: spec.size || 'wide',
  };
  if (spec.chart_type) args.chart_type = spec.chart_type;

  let rendered;
  try {
    rendered = await viz.run(args);
  } catch (err) {
    return {
      ...result,
      auto_viz_error: `auto-viz failed: ${err?.message || err}`,
    };
  }

  if (!rendered || rendered.error) {
    return {
      ...result,
      auto_viz_error: rendered?.error || 'auto-viz failed',
    };
  }

  const vizId = rendered.viz_id || rendered.projectable_id;
  return {
    ...result,
    auto_viz: true,
    auto_viz_for: datasetId,
    auto_viz_chart_type: rendered.chart_type || spec.chart_type || null,
    auto_viz_id: vizId,
    projectable_id: rendered.projectable_id || vizId,
    viz_id: vizId,
    size: rendered.size || spec.size || result.size,
    note: result.note || rendered.note,
  };
}

export async function runTool(name, args) {
  const entry = REGISTRY[name];
  if (!entry) throw new Error(`unknown tool: ${name}`);
  const result = await entry.run(args || {});
  return attachAutoViz(name, result);
}

export { getViz } from './viz/viz.js';
