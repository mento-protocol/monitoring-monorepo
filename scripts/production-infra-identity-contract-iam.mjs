import { createHash } from "node:crypto";
import {
  blockKey,
  expectExpression,
  normalizeExpression,
  topLevelBlockKey,
} from "./production-infra-identity-contract-hcl.mjs";
import { validateTerraformExecutionSurfaces } from "./production-infra-identity-contract-execution.mjs";
import { validateIamSourceProvenance } from "./production-infra-identity-contract-provenance.mjs";

const IAM_MEMBER_EXPRESSION_GROUPS = [
  {
    expression: '"allUsers"',
    blocks: [
      "alerts/infra/onchain-event-handler/main.tf:google_cloud_run_v2_service_iam_member.cloud_run_invoker",
      "alerts/infra/onchain-event-handler/main.tf:google_cloudfunctions2_function_iam_member.cloud_function_invoker",
      "governance-watchdog/infra/cloud_function.tf:google_cloud_run_v2_service_iam_member.cloud_function_invoker",
      "terraform/metrics-bridge.tf:google_cloud_run_v2_service_iam_member.metrics_bridge_public",
    ],
  },
  {
    expression:
      '"principal://iam.googleapis.com/${google_iam_workload_identity_pool.github_production_infra.name}/subject/repo:mento-protocol/monitoring-monorepo:environment:production-infra"',
    blocks: [
      "terraform/ci-wif.tf:google_service_account_iam_member.production_infra_applier_wif_binding",
    ],
  },
  {
    expression:
      '"principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_actions.name}/attribute.ref/refs/heads/main"',
    blocks: [
      "terraform/ci-wif.tf:google_service_account_iam_member.deployer_wif_binding",
    ],
  },
  {
    expression:
      '"principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_terraform_refresh.name}/attribute.ref/refs/heads/main"',
    blocks: [
      "terraform/ci-wif.tf:google_service_account_iam_member.terraform_refresh_readonly_wif_binding",
    ],
  },
  {
    expression:
      '"principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_actions.name}/attribute.repository/mento-protocol/monitoring-monorepo"',
    blocks: [
      "terraform/ci-wif.tf:google_service_account_iam_member.plan_readonly_wif_binding",
    ],
  },
  {
    expression: '"serviceAccount:${each.value}"',
    blocks: [
      "terraform/aegis-bootstrap.tf:google_service_account_iam_member.grafana_agent_cloudbuild_appengine_default_service_account_user",
    ],
  },
  {
    expression:
      '"serviceAccount:${google_project.monitoring.number}-compute@developer.gserviceaccount.com"',
    blocks: [
      "terraform/aegis-bootstrap.tf:google_secret_manager_secret_iam_member.grafana_agent_cloudbuild_compute_accessor",
    ],
  },
  {
    expression:
      '"serviceAccount:${google_project.monitoring.number}@cloudbuild.gserviceaccount.com"',
    blocks: [
      "terraform/aegis-bootstrap.tf:google_secret_manager_secret_iam_member.grafana_agent_cloudbuild_accessor",
    ],
  },
  {
    expression:
      '"serviceAccount:${google_service_account.agent_readonly.email}"',
    blocks: [
      "terraform/agent-readonly.tf:google_organization_iam_member.agent_readonly_org_roles",
      "terraform/agent-readonly.tf:google_project_iam_member.agent_readonly_storage_object_viewer",
    ],
  },
  {
    expression:
      '"serviceAccount:${google_service_account.function_runtime.email}"',
    blocks: [
      "alerts/infra/oncall-announcer/main.tf:google_secret_manager_secret_iam_member.runtime_slack_bot_token",
      "alerts/infra/oncall-announcer/main.tf:google_secret_manager_secret_iam_member.runtime_splunk_on_call_api_id",
      "alerts/infra/oncall-announcer/main.tf:google_secret_manager_secret_iam_member.runtime_splunk_on_call_api_key",
      "alerts/infra/oncall-announcer/main.tf:google_storage_bucket_iam_member.runtime_rotation_state_object_admin",
      "alerts/infra/onchain-event-handler/main.tf:google_secret_manager_secret_iam_member.runtime_quicknode_signing_secret",
      "alerts/infra/onchain-event-handler/main.tf:google_secret_manager_secret_iam_member.runtime_slack_bot_token",
      "alerts/infra/onchain-event-handler/main.tf:google_storage_bucket_iam_member.runtime_replay_nonce_creator",
    ],
  },
  {
    expression:
      '"serviceAccount:${google_service_account.metrics_bridge_deployer.email}"',
    blocks: [
      "terraform/ci-wif.tf:google_project_iam_member.ci_deployer",
      "terraform/ci-wif.tf:google_service_account_iam_member.ci_alerts_org_terraform_token_creator",
      "terraform/ci-wif.tf:google_service_account_iam_member.ci_appengine_default_service_account_user",
    ],
  },
  {
    expression:
      '"serviceAccount:${google_service_account.metrics_bridge_plan_readonly.email}"',
    blocks: [
      "terraform/ci-wif.tf:google_service_account_iam_member.ci_plan_readonly_org_terraform_plan_readonly_token_creator",
    ],
  },
  {
    expression:
      '"serviceAccount:${google_service_account.org_terraform_plan_readonly.email}"',
    blocks: [
      "terraform/ci-wif.tf:google_storage_bucket_iam_member.state_bucket_plan_readonly",
    ],
  },
  {
    expression:
      '"serviceAccount:${google_service_account.org_terraform_refresh_readonly.email}"',
    blocks: [
      "terraform/ci-wif.tf:google_storage_bucket_iam_member.state_bucket_refresh_readonly",
    ],
  },
  {
    expression:
      '"serviceAccount:${google_service_account.production_infra_applier.email}"',
    blocks: [
      "terraform/ci-wif.tf:google_service_account_iam_member.production_infra_applier_org_terraform_token_creator",
    ],
  },
  {
    expression: '"serviceAccount:${google_service_account.project_sa.email}"',
    blocks: [
      "alerts/infra/main.tf:google_project_iam_member.cloudbuild_builder",
    ],
  },
  {
    expression:
      '"serviceAccount:${google_service_account.scheduler_invoker.email}"',
    blocks: [
      "governance-watchdog/infra/scheduler.tf:google_cloud_run_v2_service_iam_member.scheduler_invoker",
    ],
  },
  {
    expression: '"serviceAccount:${google_service_account.scheduler.email}"',
    blocks: [
      "alerts/infra/oncall-announcer/main.tf:google_cloud_run_v2_service_iam_member.scheduler_cloud_run_invoker",
      "alerts/infra/oncall-announcer/main.tf:google_cloudfunctions2_function_iam_member.scheduler_function_invoker",
    ],
  },
  {
    expression:
      '"serviceAccount:${google_service_account.terraform_refresh_readonly.email}"',
    blocks: [
      "terraform/ci-wif.tf:google_service_account_iam_member.ci_refresh_readonly_org_terraform_refresh_readonly_token_creator",
    ],
  },
  {
    expression:
      '"serviceAccount:${local.aegis_app_engine_default_service_account}"',
    blocks: [
      "terraform/aegis-bootstrap.tf:google_secret_manager_secret_iam_member.grafana_agent_appspot_accessor",
    ],
  },
  {
    expression: "each.value.member",
    occurrences: [
      '"serviceAccount:${local.grafana_agent_cloudbuild_service_accounts[binding[0]]}"',
      "each.value.member",
    ],
    blocks: [
      "terraform/aegis-bootstrap.tf:google_project_iam_member.grafana_agent_cloudbuild_deployer",
    ],
  },
  {
    expression:
      '"serviceAccount:${module.governance_watchdog.service_account_email}"',
    blocks: [
      "governance-watchdog/infra/cloud_function.tf:google_project_iam_member.secret_accessor",
      "governance-watchdog/infra/cloudbuild.tf:google_project_iam_member.cloudbuild_builder",
      "governance-watchdog/infra/cloudbuild.tf:google_storage_bucket_iam_member.cloud_build_storage_access",
      "governance-watchdog/infra/storage.tf:google_storage_bucket_iam_member.runtime_replay_nonce_creator",
    ],
  },
  {
    expression: '"serviceAccount:${var.project_service_account_email}"',
    blocks: [
      "alerts/infra/oncall-announcer/main.tf:google_storage_bucket_iam_member.cloud_build_storage_access",
      "alerts/infra/onchain-event-handler/main.tf:google_storage_bucket_iam_member.cloud_build_storage_access",
    ],
  },
  {
    expression: '"serviceAccount:${var.terraform_service_account}"',
    blocks: [
      "terraform/gcp-project.tf:google_project_iam_member.terraform_owner",
    ],
  },
  {
    expression:
      '"serviceAccount:org-terraform-refresh-readonly@mento-terraform-seed-ffac.iam.gserviceaccount.com"',
    blocks: [
      "alerts/infra/main.tf:google_project_iam_member.terraform_refresh_readonly",
      "alerts/infra/oncall-announcer/main.tf:google_secret_manager_secret_iam_member.terraform_refresh_readonly",
      "alerts/infra/oncall-announcer/main.tf:google_storage_bucket_iam_member.terraform_refresh_readonly_function_source",
      "alerts/infra/onchain-event-handler/main.tf:google_secret_manager_secret_iam_member.terraform_refresh_readonly",
      "alerts/infra/onchain-event-handler/main.tf:google_storage_bucket_iam_member.terraform_refresh_readonly_function_source",
      "governance-watchdog/infra/main.tf:google_project_iam_member.terraform_refresh_readonly",
      "governance-watchdog/infra/storage.tf:google_storage_bucket_iam_member.terraform_refresh_readonly_function_source",
      "governance-watchdog/infra/terraform-refresh.tf:google_secret_manager_secret_iam_member.terraform_refresh_readonly",
    ],
  },
  {
    expression: "each.value",
    blocks: [
      "terraform/agent-readonly.tf:google_service_account_iam_member.agent_readonly_token_creators",
      "terraform/project-iam.tf:google_project_iam_member.dev_appengine_admin",
      "terraform/project-iam.tf:google_project_iam_member.dev_ar_writer",
      "terraform/project-iam.tf:google_project_iam_member.dev_cloudbuild_editor",
      "terraform/project-iam.tf:google_project_iam_member.dev_logging_viewer",
      "terraform/project-iam.tf:google_project_iam_member.dev_run_admin",
      "terraform/project-iam.tf:google_project_iam_member.dev_storage_admin",
      "terraform/project-iam.tf:google_service_account_iam_member.dev_appengine_default_service_account_user",
    ],
  },
];

const IAM_BLOCK_SHAPE_SPECIFICATIONS = [
  "alerts/infra/main.tf:google_project_iam_member.cloudbuild_builder|1e2a85b8ac47e13f11ee43309d79c321414fa21143db92ddbf702d7df10a143c",
  "alerts/infra/main.tf:google_project_iam_member.terraform_refresh_readonly|00400dd1a3f9ea6b888ab78ea5413c706037b240b12c903ca224da5fb9951958,29a4705648f6facc1edd44ac4a08fb48aa057af0cd2729114ac9d3997bcbc02c",
  "alerts/infra/oncall-announcer/main.tf:google_cloud_run_v2_service_iam_member.scheduler_cloud_run_invoker|797b07d5f23cf0ee3ae0c7f33213815a3b0bca3ae093bc325b4f649777fee059",
  "alerts/infra/oncall-announcer/main.tf:google_cloudfunctions2_function_iam_member.scheduler_function_invoker|8fe9a5fe550add31f8bb4dc98d73c1fdafdbc79409b66b8d0cefb294b747a4d2",
  "alerts/infra/oncall-announcer/main.tf:google_secret_manager_secret_iam_member.runtime_slack_bot_token|6742758ccd4e2715f0bb9bc7bc7ad9f6b3b0cf60edb96628a670f23d11d450e9",
  "alerts/infra/oncall-announcer/main.tf:google_secret_manager_secret_iam_member.runtime_splunk_on_call_api_id|d32c01ebbba9cd69a483e22250231c22613eff6b82d5ec539554c696e2d4834c",
  "alerts/infra/oncall-announcer/main.tf:google_secret_manager_secret_iam_member.runtime_splunk_on_call_api_key|12677212fd99f7b565050c14a88a4255f4cb36be943e737423af3f31dc8bf066",
  "alerts/infra/oncall-announcer/main.tf:google_secret_manager_secret_iam_member.terraform_refresh_readonly|88b218e877ea337805583af29ec3fbd80c0efec6b998fb76935493c0fd7874c4,5508776efa375194287eec8afc902bf46ebbd9b5cfce18913eee2b7129638abd",
  "alerts/infra/oncall-announcer/main.tf:google_storage_bucket_iam_member.cloud_build_storage_access|3a4cc296770d3636d5dae0f915528437d136b899d9cb4ec54774f8fb7c1cd05e",
  "alerts/infra/oncall-announcer/main.tf:google_storage_bucket_iam_member.runtime_rotation_state_object_admin|ca42a486a00996e5d5e764095b7b54431ce599e0bc21ef6d3c98fdb75f65b452",
  "alerts/infra/oncall-announcer/main.tf:google_storage_bucket_iam_member.terraform_refresh_readonly_function_source|eaa0d305087e4047469f000516b1143d9f78701d3c1d43498fd7c9f12aacc951",
  "alerts/infra/onchain-event-handler/main.tf:google_cloud_run_v2_service_iam_member.cloud_run_invoker|de0cac6c6593a02ad957afc61670b01b2c97bb8a127730c98fc9d8a0b59e9b2a",
  "alerts/infra/onchain-event-handler/main.tf:google_cloudfunctions2_function_iam_member.cloud_function_invoker|6f908053c986696b71486d30cd3fbdb506366f76d9e3af23f4fb7c30d018ffe8",
  "alerts/infra/onchain-event-handler/main.tf:google_secret_manager_secret_iam_member.runtime_quicknode_signing_secret|5af2290c5fe3ae6f82bff10df4bf8bda3a6a08134d991d792fad028454035aa9",
  "alerts/infra/onchain-event-handler/main.tf:google_secret_manager_secret_iam_member.runtime_slack_bot_token|6742758ccd4e2715f0bb9bc7bc7ad9f6b3b0cf60edb96628a670f23d11d450e9",
  "alerts/infra/onchain-event-handler/main.tf:google_secret_manager_secret_iam_member.terraform_refresh_readonly|e81944491c204e9b90deb4121a76fb98a8019c6faa391c0005d5d79c391bebdc,1e60bc675751dce84cc1c6c349452838a1d8d9f3c428287ae4b87db21969d372",
  "alerts/infra/onchain-event-handler/main.tf:google_storage_bucket_iam_member.cloud_build_storage_access|3a4cc296770d3636d5dae0f915528437d136b899d9cb4ec54774f8fb7c1cd05e",
  "alerts/infra/onchain-event-handler/main.tf:google_storage_bucket_iam_member.runtime_replay_nonce_creator|960cee568e9d8c2a3bb4417ecb364c1fd37facddb674dbac47806c2a344832e4",
  "alerts/infra/onchain-event-handler/main.tf:google_storage_bucket_iam_member.terraform_refresh_readonly_function_source|eaa0d305087e4047469f000516b1143d9f78701d3c1d43498fd7c9f12aacc951",
  "governance-watchdog/infra/cloud_function.tf:google_cloud_run_v2_service_iam_member.cloud_function_invoker|1baacd2d37d9f4329b95dcf03f6a20ea0d8d5c52c1ca8fcdf2f92d09ba42e993",
  "governance-watchdog/infra/cloud_function.tf:google_project_iam_member.secret_accessor|4918cf5acf2e8c25e97db6237fb0d4d015f49ee07b711e397f2387cb3e37fe34",
  "governance-watchdog/infra/cloudbuild.tf:google_project_iam_member.cloudbuild_builder|c4fb4b2d1b66eaf281d33105a8735cabc1cc997d2d58ab1dbdacee2d96a8b01b",
  "governance-watchdog/infra/cloudbuild.tf:google_storage_bucket_iam_member.cloud_build_storage_access|1caaa6bb593a39ff6c53b676bd7b7c062317c2047acbbaa847617d93a57d2f23",
  "governance-watchdog/infra/main.tf:google_project_iam_member.terraform_refresh_readonly|6b6c08ffbd074e1be946282244dcb0edd9417d8e0c11ef97a1497a164dc04646,d176efa24cb8a2419447eda60757688a4b8b5ce2679d24740126224ab0e173b6",
  "governance-watchdog/infra/scheduler.tf:google_cloud_run_v2_service_iam_member.scheduler_invoker|d78674cd7eaa8caedb1809acef4d87a68bf89911ab9d82386cf2de92527d0757",
  "governance-watchdog/infra/storage.tf:google_storage_bucket_iam_member.runtime_replay_nonce_creator|8bb2118a160aec2cd5f0ec0220365a6c47994338c0efe0395ce418333dba65d4",
  "governance-watchdog/infra/storage.tf:google_storage_bucket_iam_member.terraform_refresh_readonly_function_source|c2ff2a185d750f14790ea1c5fa2618beef801ec7b031b64b1664b7b63bb20e06",
  "governance-watchdog/infra/terraform-refresh.tf:google_secret_manager_secret_iam_member.terraform_refresh_readonly|f83e2401c8bcb4f025ce75e08373a4cbfd4d92b8204d9f3c79b5d0a92477f320,0fdfcbd003626f0badbd071ed9eafc80f9ceab9d2de1486404e075d1cb34053d",
  "terraform/aegis-bootstrap.tf:google_project_iam_member.grafana_agent_cloudbuild_deployer|5bda4cf104c025e604ac462f05a0936bb6dc805de0fbb5bf52cfb27ed9ae094c",
  "terraform/aegis-bootstrap.tf:google_secret_manager_secret_iam_member.grafana_agent_appspot_accessor|94c851425e7ee6828fdd263880505e7592dc39921192cfa0bede42e11908eb75",
  "terraform/aegis-bootstrap.tf:google_secret_manager_secret_iam_member.grafana_agent_cloudbuild_accessor|093901800fdf61475d1dd5a4be6bddff7e05d0691c7d062a4d8c8d2c21c5188a",
  "terraform/aegis-bootstrap.tf:google_secret_manager_secret_iam_member.grafana_agent_cloudbuild_compute_accessor|7460e94dd1796e89ef5a8807871d71c9197a14f14491ec48b87722780771afb6",
  "terraform/aegis-bootstrap.tf:google_service_account_iam_member.grafana_agent_cloudbuild_appengine_default_service_account_user|872132ad8138a50c19dc97d379b205caf085f4cedd989e39ec0fdbc082f3fd5b",
  "terraform/agent-readonly.tf:google_organization_iam_member.agent_readonly_org_roles|7c3104c85aed42208922ae49b7bcf3ccad1a92fd0550d512da1cc2e98c54803c",
  "terraform/agent-readonly.tf:google_project_iam_member.agent_readonly_storage_object_viewer|711050d13fd79a3a8824657145fe93b3453c1d7b6ffbe31ebdf7e658c3a3398f",
  "terraform/agent-readonly.tf:google_service_account_iam_member.agent_readonly_token_creators|70839f6d974946314e5657a18e65df3afff646801c915595ed125f619557f188",
  "terraform/ci-wif.tf:google_project_iam_member.ci_deployer|baeabc756e63cb7199f2e4cbb227eb457e10e5239e95cb0232ee8591a9b34f9b",
  "terraform/ci-wif.tf:google_service_account_iam_member.ci_alerts_org_terraform_token_creator|9a92def649ccee67f6f6c820842138698834b7aeafed4b50c8f802d63ea8e359,9fdb25d39e0a61872f93aed03d6f089c8775c6228592d16b58b9f8fcf6c13e9d",
  "terraform/ci-wif.tf:google_service_account_iam_member.ci_appengine_default_service_account_user|5abbcb1b4d14a91e5cba70cf7a81af90be95754f83f2d8d15581e68794b3ee0b",
  "terraform/ci-wif.tf:google_service_account_iam_member.ci_plan_readonly_org_terraform_plan_readonly_token_creator|12f23643afcc9349e76c1c0c2972acb6145adf62388c784b6f3602c530474541",
  "terraform/ci-wif.tf:google_service_account_iam_member.ci_refresh_readonly_org_terraform_refresh_readonly_token_creator|4a6e6bd58072639804c56a55a26356285a19b8d8eec83ac8732102e988e6979c",
  "terraform/ci-wif.tf:google_service_account_iam_member.deployer_wif_binding|4c3302eaade9e7dccb17daed9e44c4e3c3645a9d0d4a1fa67606d9632c544218",
  "terraform/ci-wif.tf:google_service_account_iam_member.plan_readonly_wif_binding|c9a6cbe51dba7d93657c8452632749d9565d1b1c6a17eee214ea936b4ef66c63",
  "terraform/ci-wif.tf:google_service_account_iam_member.production_infra_applier_org_terraform_token_creator|9e881005142ca12c27f535de78917f7d6adf29adcf693bf1791a5a71b628a0a6",
  "terraform/ci-wif.tf:google_service_account_iam_member.production_infra_applier_wif_binding|579a866f0b22a52d882c5a4b5782d3f4777e5ed3da4447632e531eee1bc9a446",
  "terraform/ci-wif.tf:google_service_account_iam_member.terraform_refresh_readonly_wif_binding|a10d7bdebc3992fb450224b6850e35b442c174bc629d63826a39c89d29ebcb09",
  "terraform/ci-wif.tf:google_storage_bucket_iam_member.state_bucket_plan_readonly|14bfbae95fdd8cf89f98a71d6b0ff755e291f25ed5d946d633614813734e4ac5",
  "terraform/ci-wif.tf:google_storage_bucket_iam_member.state_bucket_refresh_readonly|f6756d526277862e2378cd24b6605b16725030c636d67e8a483411435ad6998f",
  "terraform/gcp-project.tf:google_project_iam_member.terraform_owner|3280f80f6f5a6293d453a3d550eeeab7a818dbb8d313160fac41df4753012d4a",
  "terraform/metrics-bridge.tf:google_cloud_run_v2_service_iam_member.metrics_bridge_public|9bd48a6d3612b82847564ed91fdcd3199dfe565bde34d18eb5df2c4d635a8a4a",
  "terraform/project-iam.tf:google_project_iam_member.dev_appengine_admin|46e0559a495dac87da8892c4b007a3aea38193c9cf3a05aa8d256c4a52c0770d",
  "terraform/project-iam.tf:google_project_iam_member.dev_ar_writer|2ff84334fef6c77f3fbca0d073eb5695a2356bb9fa51b756745b75dcb6a84b1b",
  "terraform/project-iam.tf:google_project_iam_member.dev_cloudbuild_editor|1cc71220cc894b2085f247a727722870eeb23cb6b913837a4008050de106009e",
  "terraform/project-iam.tf:google_project_iam_member.dev_logging_viewer|d2f2c306e299614598f508a5238e3e022bb94d0948111807badcf0585462684d",
  "terraform/project-iam.tf:google_project_iam_member.dev_run_admin|0bef1a2ef3f3e1290da70515c352fa47aa9f0919ff1b5cbd1b37fd91b67b8fb4",
  "terraform/project-iam.tf:google_project_iam_member.dev_storage_admin|5757062a847016a340ae756d7ae0d09efb42b48858477374e28e360cbc09f199",
  "terraform/project-iam.tf:google_service_account_iam_member.dev_appengine_default_service_account_user|2885093a983d9300628bfe425e04c5e3fbae26f82367e6c13cc1bbedbd05e010",
];

const MODULE_BLOCK_SHAPE_SPECIFICATIONS = [
  "aegis/terraform/main.tf:module.grafana_dashboard|e91ec8aba7c7347f74f6896a4eb52e2e8ebb588ea5a582cbb39929333870bcbe",
  "alerts/infra/main.tf:module.oncall_announcer|301aef0a9ea1033e937bd28b68ff7c9f23fc5ba8671e2e4201c5d8d2172bcb07",
  "alerts/infra/main.tf:module.onchain_event_handler|4a9d935f8be2b979b2da133c4c01762813106f1d4ac60b53721f2492918843a1",
  "alerts/infra/main.tf:module.onchain_event_listeners|a48ff45e601e93a881fa4e87f73f704761de0f6724c1437c70d95f7e231b3f0f",
  "alerts/infra/main.tf:module.project_factory|d2f60b3af4237c2c4e2135bc15cd026a3be8d5c477e4b31f58d13765f721153c",
  "alerts/infra/main.tf:module.sentry_bridge|86ac2b1628c5579c58defcbd8ef54dc978c6f44cd622ccc488db77b11e7dd225",
  "alerts/infra/main.tf:module.slack_channels|c3eaa2c32b7fbea2e34c5df9baec7a198d39a6fe8a9452e37adb2af7149c096c",
  "governance-watchdog/infra/main.tf:module.governance_watchdog|b7ae97cf278cdd1108b54f83143b099d94b0e7b514c6e6dac526dfa7ba94c80f",
];

const IDENTITY_SOURCE_BLOCK_SHAPE_SPECIFICATIONS = [
  "alerts/infra/main.tf:google_service_account.project_sa|489692d2bf835a45adf4d4f7d42022ca4c2a440fb5b65afe2ab3c59fd1d5341e",
  "alerts/infra/oncall-announcer/main.tf:google_service_account.function_runtime|fa16e6ee0550b30720312a6109ffe44112d0dfe41baef39ce66fdb95825465d4",
  "alerts/infra/oncall-announcer/main.tf:google_service_account.scheduler|098c4d6b3ddac9c9d5451aef0a303140417c56cd4475fc9ff1d17f042856b97e",
  "alerts/infra/onchain-event-handler/main.tf:google_service_account.function_runtime|a3b17fdfa196314caf2c19ac627d5442f254c5d9118d2e207226c32b9b8582f0",
  "governance-watchdog/infra/scheduler.tf:google_service_account.scheduler_invoker|70e455ebc7e41da7dc0078fb00d6643af9c0634982262d3c5cd340eac7cd227e",
  "terraform/agent-readonly.tf:google_service_account.agent_readonly|834eabe3ade9753f7a947c28c8cee40983352d1208c1b11c1f7974e17be64499",
  "terraform/ci-wif.tf:google_service_account.metrics_bridge_deployer|ce299e0e1c290cca2c98446508e334010819da839a022bec6e9993b29c8050ec",
  "terraform/ci-wif.tf:google_service_account.metrics_bridge_plan_readonly|24628df00c7031ae0ca5ee2a6fa559b6f257cdb519619b9fe0f885c8715960b0",
  "terraform/ci-wif.tf:google_service_account.org_terraform_plan_readonly|f8085c49ff045f8b86710a39f32df57a597725a83997c589e3bd48e6ce406dc1",
  "terraform/ci-wif.tf:google_service_account.org_terraform_refresh_readonly|67d108a7649109cdeb3cd63eabd144d5623049b5e848543d611b694c1efb3684,8a129ed148c03bbf7a5b1c2e1e81b977e3a37bd0e09124d9e24c9e51c1a1894a",
  "terraform/ci-wif.tf:google_service_account.production_infra_applier|02bb20c0c7f7c5550ff341f77f85dcfa00cd0b4615936eb6a1e18ea6923c11d5,53ab416891c6eeba7ad063fd45341139fba6a8e7d341a5e45242b7be76f08e1f",
  "terraform/ci-wif.tf:google_service_account.terraform_refresh_readonly|c51792f5180d455dd87e9acbea26fa08a50b24a91bc4e4a93e01149f80007b66,73b3810af667664ebddf1aa217846be5cffe9340970a7d0a53d3d4e7a4fb2b05",
];

function buildExpectedMemberExpressions() {
  const expected = new Map();
  for (const group of IAM_MEMBER_EXPRESSION_GROUPS) {
    for (const key of group.blocks) {
      if (expected.has(key)) {
        throw new Error(`duplicate IAM grant sink registry entry: ${key}`);
      }
      expected.set(key, {
        expression: group.expression,
        occurrences: group.occurrences ?? [group.expression],
      });
    }
  }
  return expected;
}

const EXPECTED_MEMBER_EXPRESSION_BY_BLOCK = buildExpectedMemberExpressions();

function buildBlockShapeRegistry(specifications, label) {
  const registry = new Map();
  for (const specification of specifications) {
    const separator = specification.lastIndexOf("|");
    const key = specification.slice(0, separator);
    const hashes = specification.slice(separator + 1).split(",");
    if (
      separator < 1 ||
      hashes.some((hash) => !/^[0-9a-f]{64}$/u.test(hash)) ||
      registry.has(key)
    ) {
      throw new Error(`invalid ${label} block shape registry entry: ${key}`);
    }
    registry.set(key, new Set(hashes));
  }
  return registry;
}

const EXPECTED_IAM_BLOCK_SHAPES = buildBlockShapeRegistry(
  IAM_BLOCK_SHAPE_SPECIFICATIONS,
  "IAM grant sink",
);
const EXPECTED_MODULE_BLOCK_SHAPES = buildBlockShapeRegistry(
  MODULE_BLOCK_SHAPE_SPECIFICATIONS,
  "Terraform module",
);
const EXPECTED_IDENTITY_SOURCE_BLOCK_SHAPES = buildBlockShapeRegistry(
  IDENTITY_SOURCE_BLOCK_SHAPE_SPECIFICATIONS,
  "IAM identity source",
);

if (
  EXPECTED_IAM_BLOCK_SHAPES.size !== EXPECTED_MEMBER_EXPRESSION_BY_BLOCK.size ||
  [...EXPECTED_IAM_BLOCK_SHAPES].some(
    ([key]) => !EXPECTED_MEMBER_EXPRESSION_BY_BLOCK.has(key),
  )
) {
  throw new Error(
    "IAM grant sink member and block shape registries must contain the same keys",
  );
}

function blockShape(block) {
  return createHash("sha256").update(block.text).digest("hex");
}

function validateBlockShapeInventory(
  blocks,
  registry,
  { keyFor, label, rejectUnregistered, completeInventory },
  errors,
) {
  const blocksByKey = Map.groupBy(blocks, keyFor);
  const duplicates = [...blocksByKey]
    .filter(([, matching]) => matching.length > 1)
    .map(([key]) => key)
    .sort();
  if (duplicates.length > 0) {
    errors.push(
      `${label} must be declared at most once: ${duplicates.join(", ")}`,
    );
  }

  const unregistered = new Set();
  for (const block of blocks) {
    const key = keyFor(block);
    const expected = registry.get(key);
    if (expected === undefined) {
      if (rejectUnregistered) unregistered.add(key);
      continue;
    }
    const actual = blockShape(block);
    if (!expected.has(actual)) {
      errors.push(
        `${key}: ${label} must match its exact audited shape (found ${actual})`,
      );
    }
  }
  if (unregistered.size > 0) {
    errors.push(
      `terraform: unregistered ${label} are forbidden: ${[...unregistered].sort().join(", ")}`,
    );
  }
  if (completeInventory) {
    const missing = [...registry.keys()]
      .filter((key) => !blocksByKey.has(key))
      .sort();
    if (missing.length > 0) {
      errors.push(`${label} are missing: ${missing.join(", ")}`);
    }
  }
}

function memberExpressions(block) {
  return [...block.code.matchAll(/^\s*member\s*=\s*(.*?)\s*$/gmu)].map(
    (match) => normalizeExpression(match[1]),
  );
}

export function iamBlocks(blocks) {
  return blocks.filter((block) =>
    /_iam_(?:member|binding|policy)$/u.test(block.type),
  );
}

export function validateIamGrantSinkInventory(
  files,
  blocks,
  errors,
  completeInventory = false,
) {
  validateTerraformExecutionSurfaces(files, blocks, errors, completeInventory);
  const sinks = iamBlocks(blocks);
  validateBlockShapeInventory(
    sinks,
    EXPECTED_IAM_BLOCK_SHAPES,
    {
      keyFor: blockKey,
      label: "IAM grant sinks",
      rejectUnregistered: true,
      completeInventory,
    },
    errors,
  );

  for (const block of sinks) {
    const key = blockKey(block);
    const specification = EXPECTED_MEMBER_EXPRESSION_BY_BLOCK.get(key);
    if (specification === undefined) {
      continue;
    }
    if (specification.occurrences.length === 1) {
      expectExpression(
        block,
        "member",
        specification.expression,
        errors,
        `${key}: IAM grant sink`,
      );
    } else {
      const actual = memberExpressions(block);
      const expected = specification.occurrences.map(normalizeExpression);
      if (
        actual.length !== expected.length ||
        actual.some((value, index) => value !== expected[index])
      ) {
        errors.push(
          `${key}: IAM grant sink: member must be exactly ${specification.expression}`,
        );
      }
    }
  }

  const unauditedPolicies = sinks
    .filter((block) => block.type.endsWith("_iam_policy"))
    .map(blockKey)
    .filter((key) => !EXPECTED_IAM_BLOCK_SHAPES.has(key))
    .sort();
  if (unauditedPolicies.length > 0) {
    errors.push(
      `terraform: IAM policy sinks are forbidden unless explicitly audited: ${unauditedPolicies.join(", ")}`,
    );
  }

  const modules = blocks.filter((block) => block.kind === "module");
  validateBlockShapeInventory(
    modules,
    EXPECTED_MODULE_BLOCK_SHAPES,
    {
      keyFor: topLevelBlockKey,
      label: "Terraform module calls",
      rejectUnregistered: true,
      completeInventory,
    },
    errors,
  );

  const identitySources = blocks.filter(
    (block) =>
      block.kind === "resource" && block.type === "google_service_account",
  );
  validateBlockShapeInventory(
    identitySources,
    EXPECTED_IDENTITY_SOURCE_BLOCK_SHAPES,
    {
      keyFor: blockKey,
      label: "IAM identity source resources",
      rejectUnregistered: true,
      completeInventory,
    },
    errors,
  );

  validateIamSourceProvenance(blocks, errors, completeInventory);
}
