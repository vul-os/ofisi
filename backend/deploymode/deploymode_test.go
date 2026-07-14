package deploymode

import "testing"

func TestFromEnv_Unset_DefaultsStandalone(t *testing.T) {
	t.Setenv(EnvVar, "")
	m, err := FromEnv()
	if err != nil {
		t.Fatalf("unset DEPLOY_MODE: unexpected error %v", err)
	}
	if m != Standalone {
		t.Fatalf("unset DEPLOY_MODE = %q, want %q", m, Standalone)
	}
}

func TestFromEnv_ValidValues(t *testing.T) {
	cases := map[string]Mode{
		"standalone": Standalone,
		"os":         OS,
		// case-insensitive + surrounding whitespace tolerated.
		"  STANDALONE ": Standalone,
		"Os":            OS,
	}
	for raw, want := range cases {
		t.Run(raw, func(t *testing.T) {
			t.Setenv(EnvVar, raw)
			m, err := FromEnv()
			if err != nil {
				t.Fatalf("FromEnv(%q): unexpected error %v", raw, err)
			}
			if m != want {
				t.Fatalf("FromEnv(%q) = %q, want %q", raw, m, want)
			}
		})
	}
}

// TestFromEnv_CloudRejected proves the retired multi-tenant "cloud" mode is no
// longer a recognised value: it degrades to the safe Standalone default with an
// error rather than resurrecting the removed presign path.
func TestFromEnv_CloudRejected(t *testing.T) {
	t.Setenv(EnvVar, "cloud")
	m, err := FromEnv()
	if err == nil {
		t.Fatalf("retired DEPLOY_MODE=cloud: expected an error, got nil")
	}
	if m != Standalone {
		t.Fatalf("retired DEPLOY_MODE=cloud = %q, want fallback %q", m, Standalone)
	}
}

func TestFromEnv_InvalidValue_FallsBackWithError(t *testing.T) {
	t.Setenv(EnvVar, "hybrid")
	m, err := FromEnv()
	if err == nil {
		t.Fatalf("invalid DEPLOY_MODE: expected an error, got nil")
	}
	if m != Standalone {
		t.Fatalf("invalid DEPLOY_MODE = %q, want fallback %q", m, Standalone)
	}
}

func TestMode_Valid(t *testing.T) {
	for _, m := range []Mode{Standalone, OS} {
		if !m.Valid() {
			t.Errorf("%q should be Valid()", m)
		}
	}
	for _, bad := range []Mode{"cloud", "nope"} {
		if bad.Valid() {
			t.Errorf("Mode(%q) should not be Valid()", bad)
		}
	}
}

func TestMode_IsCloudAdjacent(t *testing.T) {
	if Standalone.IsCloudAdjacent() {
		t.Errorf("standalone must not be cloud-adjacent")
	}
	if !OS.IsCloudAdjacent() {
		t.Errorf("os must be cloud-adjacent")
	}
}

func TestLoad_NeverPanics(t *testing.T) {
	t.Setenv(EnvVar, "garbage")
	// Load must degrade to Standalone and never panic on a bad value.
	if m := Load(); m != Standalone {
		t.Fatalf("Load() with garbage = %q, want %q", m, Standalone)
	}
}

// TestRequireAuthPosture is the fail-closed hosted-mode boot-gate regression
// guard. An OS-hosted mode with NEITHER native auth NOR a wired session
// introspector must be REFUSED (Load/main turns the error into a fatal), because
// the protected/write route groups would otherwise install no auth middleware
// and every caller would collapse to the single shared "self" identity — a
// silent fail-open. Standalone must always be allowed.
func TestRequireAuthPosture(t *testing.T) {
	cases := []struct {
		name            string
		mode            Mode
		authEnabled     bool
		hasIntrospector bool
		wantErr         bool
	}{
		// VULN case: hosted mode, no auth wall at all → must refuse to boot.
		{"os_no_auth_no_introspector_REFUSED", OS, false, false, true},

		// Hosted mode with EITHER identity source → boot proceeds.
		{"os_auth_enabled_ok", OS, true, false, false},
		{"os_introspector_ok", OS, false, true, false},
		{"os_both_ok", OS, true, true, false},

		// Standalone single-tenant self-host: always allowed, even with no auth.
		{"standalone_no_auth_ok", Standalone, false, false, false},
		{"standalone_auth_ok", Standalone, true, false, false},
		{"standalone_introspector_ok", Standalone, false, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.mode.RequireAuthPosture(tc.authEnabled, tc.hasIntrospector)
			if tc.wantErr && err == nil {
				t.Fatalf("VULN: %s.RequireAuthPosture(auth=%v, introspector=%v) = nil, want a boot-refusal error",
					tc.mode, tc.authEnabled, tc.hasIntrospector)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("%s.RequireAuthPosture(auth=%v, introspector=%v) = %v, want nil (must boot)",
					tc.mode, tc.authEnabled, tc.hasIntrospector, err)
			}
		})
	}
}
