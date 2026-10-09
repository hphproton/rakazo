-- Team desktop wake persists `booting`, the same lifecycle word as computers.
-- The original check was written before that state existed.
ALTER TABLE "team_desktops" DROP CONSTRAINT "team_desktops_state_check";
ALTER TABLE "team_desktops" ADD CONSTRAINT "team_desktops_state_check" CHECK ("state" IN ('reserved', 'booting', 'running', 'stopped', 'releasing'));
