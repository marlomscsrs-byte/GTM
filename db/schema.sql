CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS usuarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(40) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nome VARCHAR(120) NOT NULL,
  patente VARCHAR(80),
  email VARCHAR(160),
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  aprovado BOOLEAN NOT NULL DEFAULT FALSE,
  ultimo_acesso TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS efetivo (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  nome VARCHAR(120) NOT NULL,
  matricula VARCHAR(30) UNIQUE,
  patente VARCHAR(80),
  status VARCHAR(40) DEFAULT 'Disponível',
  unidade VARCHAR(80),
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  data_ingresso DATE,
  observacoes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ocorrencias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  protocolo VARCHAR(30) UNIQUE NOT NULL,
  tipo VARCHAR(80) NOT NULL,
  titulo VARCHAR(180) NOT NULL,
  descricao TEXT,
  local VARCHAR(180),
  status VARCHAR(40) DEFAULT 'Aberta',
  criado_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS servicos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  data TIMESTAMPTZ NOT NULL,
  equipe VARCHAR(80),
  funcao VARCHAR(80),
  responsavel UUID REFERENCES efetivo(id) ON DELETE SET NULL,
  status VARCHAR(40) DEFAULT 'Programado',
  observacoes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cursos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome VARCHAR(160) NOT NULL,
  descricao TEXT,
  validade_meses INT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS certificacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  efetivo_id UUID NOT NULL REFERENCES efetivo(id) ON DELETE CASCADE,
  curso_id UUID NOT NULL REFERENCES cursos(id) ON DELETE CASCADE,
  concluido_em DATE,
  validade DATE,
  status VARCHAR(40) DEFAULT 'Válida',
  UNIQUE(efetivo_id, curso_id)
);

CREATE TABLE IF NOT EXISTS motocicletas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prefixo VARCHAR(30) UNIQUE NOT NULL,
  modelo VARCHAR(100) NOT NULL,
  placa VARCHAR(20),
  status VARCHAR(40) DEFAULT 'Disponível',
  quilometragem INT DEFAULT 0,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS manutencoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  motocicleta_id UUID NOT NULL REFERENCES motocicletas(id) ON DELETE CASCADE,
  tipo VARCHAR(100),
  descricao TEXT,
  data DATE,
  quilometragem INT,
  status VARCHAR(40) DEFAULT 'Aberta',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS comunicados (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo VARCHAR(180) NOT NULL,
  mensagem TEXT NOT NULL,
  prioridade VARCHAR(30) DEFAULT 'Normal',
  autor UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  publicado BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS logs (
  id BIGSERIAL PRIMARY KEY,
  usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  acao VARCHAR(120) NOT NULL,
  entidade VARCHAR(80),
  entidade_id UUID,
  detalhes JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ocorrencias_created ON ocorrencias(created_at);
CREATE INDEX IF NOT EXISTS idx_servicos_data ON servicos(data);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
