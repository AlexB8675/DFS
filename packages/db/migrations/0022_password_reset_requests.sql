-- Someone asked for a new password from the sign-in page (DESIGN §7.1):
-- the admins see it until one sets a temporary password, or they sign in.
ALTER TABLE "users" ADD COLUMN "password_reset_requested_at" timestamp with time zone;