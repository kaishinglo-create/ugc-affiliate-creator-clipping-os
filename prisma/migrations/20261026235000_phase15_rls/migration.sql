DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['OperationalPolicy','ContentLifecycleEvent']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_workspace_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING ("workspaceId" = current_workspace_id()) WITH CHECK ("workspaceId" = current_workspace_id())',
      t || '_workspace_isolation', t
    );
  END LOOP;
END $$;
