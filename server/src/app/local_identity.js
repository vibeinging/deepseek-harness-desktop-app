/**
 * Local single-user mode ownership identifier.
 *
 * Desktop app has no account/login/token. This fixed ID only keeps existing
 * columns like created_by, company_id, and project_members compatible; it is not a real login user.
 */
export const LOCAL_COMPANY_ID = '00000000-0000-0000-0000-000000000000';
export const LOCAL_OWNER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Legacy schema still requires company/user rows. At startup, create two internal records idempotently.
 * Do not expose user-facing APIs, and do not store a usable password.
 */
export async function ensureLocalIdentity({ query }) {
  await query(
    `INSERT INTO companies (id,name,code,is_active,created_at,updated_at)
     VALUES ($1,'本地工作区','local',true,now(),now())
     ON CONFLICT(id) DO NOTHING`,
    [LOCAL_COMPANY_ID],
  );
  await query(
    `INSERT INTO users (id,company_id,username,password_hash,full_name,is_admin,can_create_project,is_active,created_at,updated_at)
     VALUES ($1,$2,'local-owner','no-login','本地数据归属',true,true,true,now(),now())
     ON CONFLICT(id) DO NOTHING`,
    [LOCAL_OWNER_ID, LOCAL_COMPANY_ID],
  );
}
