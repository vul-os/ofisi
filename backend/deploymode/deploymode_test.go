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
		"cloud":      Cloud,
		// case-insensitive + surrounding whitespace tolerated.
		"  CLOUD ": Cloud,
		"Os":       OS,
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
	for _, m := range []Mode{Standalone, OS, Cloud} {
		if !m.Valid() {
			t.Errorf("%q should be Valid()", m)
		}
	}
	if Mode("nope").Valid() {
		t.Errorf(`Mode("nope") should not be Valid()`)
	}
}

func TestMode_IsCloudAdjacent(t *testing.T) {
	if Standalone.IsCloudAdjacent() {
		t.Errorf("standalone must not be cloud-adjacent")
	}
	if !OS.IsCloudAdjacent() {
		t.Errorf("os must be cloud-adjacent")
	}
	if !Cloud.IsCloudAdjacent() {
		t.Errorf("cloud must be cloud-adjacent")
	}
}

func TestMode_UsesPresignStorage(t *testing.T) {
	if Standalone.UsesPresignStorage() || OS.UsesPresignStorage() {
		t.Errorf("only cloud uses the presign storage seam")
	}
	if !Cloud.UsesPresignStorage() {
		t.Errorf("cloud must use the presign storage seam")
	}
}

func TestLoad_NeverPanics(t *testing.T) {
	t.Setenv(EnvVar, "garbage")
	// Load must degrade to Standalone and never panic on a bad value.
	if m := Load(); m != Standalone {
		t.Fatalf("Load() with garbage = %q, want %q", m, Standalone)
	}
}
