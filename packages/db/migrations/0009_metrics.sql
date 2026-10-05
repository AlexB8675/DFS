CREATE TABLE "metrics" (
	"name" text NOT NULL,
	"step" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"sum" double precision NOT NULL,
	"count" double precision NOT NULL,
	"max" double precision NOT NULL,
	CONSTRAINT "metrics_pkey" PRIMARY KEY("name","step","at")
)
-- Each flush updates its buckets' rows: room left in each page keeps those updates HOT.
WITH (fillfactor = 70);
