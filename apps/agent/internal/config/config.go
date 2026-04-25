package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type Config struct {
	NodeID                  string `yaml:"node_id"`
	MasterURL               string `yaml:"master_url"`
	AgentToken              string `yaml:"agent_token"`
	CollectIntervalSeconds  int    `yaml:"collect_interval_seconds"`
	TaskPollIntervalSeconds int    `yaml:"task_poll_interval_seconds"`
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if cfg.CollectIntervalSeconds == 0 {
		cfg.CollectIntervalSeconds = 10
	}
	if cfg.TaskPollIntervalSeconds == 0 {
		cfg.TaskPollIntervalSeconds = 5
	}
	return &cfg, nil
}

func Save(path string, cfg *Config) error {
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}
