-- #584: provider defaults can grant destructive privileges to service_role.
-- The existing row trigger protects DELETE/UPDATE, but cannot intercept TRUNCATE.
-- Keep the SELECT/INSERT/UPDATE command contract and all stored history intact.
revoke delete, truncate on table public.assignment_change_requests from service_role;
