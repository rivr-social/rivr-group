-- Social link columns for faster queries and typed access
ALTER TABLE agents ADD COLUMN IF NOT EXISTS website text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS x_handle text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS instagram text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS linkedin text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS telegram text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS signal_handle text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS phone_number text;
