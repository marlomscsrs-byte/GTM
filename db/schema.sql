CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS usuarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(40) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nome VARCHAR(120) NOT NULL,
  patente VARCHAR(80),
  matricula VARCHAR(30),
  email VARCHAR(160),
  telefone_cidade VARCHAR(30),
  role VARCHAR(30) NOT NULL DEFAULT 'operador',
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  aprovado BOOLEAN NOT NULL DEFAULT FALSE,
  status_cadastro VARCHAR(20) NOT NULL DEFAULT 'pendente',
  ultimo_acesso TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS role VARCHAR(30) NOT NULL DEFAULT 'operador';
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefone_cidade VARCHAR(30);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS matricula VARCHAR(30);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS status_cadastro VARCHAR(20) NOT NULL DEFAULT 'pendente';
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_matricula ON usuarios(matricula) WHERE matricula IS NOT NULL;
-- Migração de cadastros antigos: contas não aprovadas e inativas voltam a aparecer como pendentes.
UPDATE usuarios
SET status_cadastro='pendente'
WHERE COALESCE(aprovado,false)=false
  AND COALESCE(ativo,false)=false
  AND LOWER(COALESCE(status_cadastro,'pendente')) NOT IN ('recusado','reprovado');
-- Migração segura de contas antigas já aprovadas.
UPDATE usuarios SET status_cadastro='aprovado' WHERE aprovado=true AND ativo=true AND status_cadastro='pendente';

CREATE TABLE IF NOT EXISTS efetivo (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  nome VARCHAR(120) NOT NULL,
  matricula VARCHAR(30) UNIQUE,
  patente VARCHAR(80),
  status VARCHAR(40) DEFAULT 'Ativo',
  unidade VARCHAR(80),
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  data_ingresso DATE,
  observacoes TEXT,
  telefone_cidade VARCHAR(30),
  cadastro_key VARCHAR(80) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE efetivo ADD COLUMN IF NOT EXISTS cadastro_key VARCHAR(80);
ALTER TABLE efetivo ADD COLUMN IF NOT EXISTS telefone_cidade VARCHAR(30);
CREATE UNIQUE INDEX IF NOT EXISTS idx_efetivo_cadastro_key ON efetivo(cadastro_key) WHERE cadastro_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS ocorrencias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  protocolo VARCHAR(30) UNIQUE NOT NULL,
  tipo VARCHAR(80) NOT NULL,
  titulo VARCHAR(180) NOT NULL,
  descricao TEXT,
  local VARCHAR(180),
  status VARCHAR(40) DEFAULT 'Aberta',
  criado_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  qru_dados JSONB DEFAULT '{}'::jsonb,
  foto_url TEXT,
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
  telefone_cidade VARCHAR(30),
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


CREATE TABLE IF NOT EXISTS eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo VARCHAR(180) NOT NULL,
  descricao TEXT,
  data_evento TIMESTAMPTZ NOT NULL,
  local VARCHAR(180),
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evento_participantes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evento_id UUID NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  status VARCHAR(30) NOT NULL DEFAULT 'pendente',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(evento_id, usuario_id)
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

ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS qru_dados JSONB DEFAULT '{}'::jsonb;
ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS foto_url TEXT;
CREATE INDEX IF NOT EXISTS idx_ocorrencias_created ON ocorrencias(created_at);
CREATE INDEX IF NOT EXISTS idx_servicos_data ON servicos(data);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);

-- O efetivo começa vazio. Um autocadastro fica pendente e só entra no efetivo
-- depois da aprovação do Comando. A aprovação cria e vincula o registro automaticamente.


CREATE TABLE IF NOT EXISTS pontos_servico (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  efetivo_id UUID NOT NULL REFERENCES efetivo(id) ON DELETE CASCADE,
  entrada TIMESTAMPTZ NOT NULL DEFAULT now(),
  saida TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'em_servico',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pontos_servico_usuario ON pontos_servico(usuario_id, entrada DESC);
CREATE INDEX IF NOT EXISTS idx_pontos_servico_status ON pontos_servico(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pontos_servico_um_ativo_por_usuario
  ON pontos_servico(usuario_id) WHERE status='em_servico';


CREATE TABLE IF NOT EXISTS acoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  tipo VARCHAR(100) NOT NULL,
  resultado VARCHAR(30) NOT NULL,
  negociacao TEXT,
  titulo VARCHAR(180) NOT NULL,
  descricao TEXT,
  veiculos JSONB NOT NULL DEFAULT '[]'::jsonb,
  oficiais JSONB NOT NULL DEFAULT '[]'::jsonb,
  pontos NUMERIC(10,1) NOT NULL DEFAULT 3.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_acoes_created ON acoes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acoes_usuario ON acoes(usuario_id, created_at DESC);

-- Progressão GTM: somente dois níveis de carreira. As metas são definidas pelo Comando.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS nivel_carreira VARCHAR(20);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cargo VARCHAR(40) DEFAULT 'Piloto Probatório';
ALTER TABLE efetivo ADD COLUMN IF NOT EXISTS nivel_carreira VARCHAR(20);
ALTER TABLE efetivo ADD COLUMN IF NOT EXISTS cargo VARCHAR(40) DEFAULT 'Piloto Probatório';
UPDATE efetivo SET cargo = CASE
  WHEN LOWER(COALESCE(unidade,''))='comando' OR LOWER(COALESCE(patente,''))='comando' THEN 'Comando'
  WHEN LOWER(COALESCE(unidade,'')) IN ('sub-comando','subcomando') THEN 'Sub-Comando'
  WHEN LOWER(COALESCE(unidade,''))='supervisor' THEN 'Supervisor'
  WHEN LOWER(COALESCE(unidade,''))='piloto oficial' OR LOWER(COALESCE(patente,''))='piloto oficial' THEN 'Piloto Oficial'
  ELSE 'Probatório' END
WHERE cargo IS NULL OR cargo='' OR cargo='Piloto Probatório';
UPDATE usuarios SET cargo = CASE
  WHEN LOWER(COALESCE(patente,''))='comando' THEN 'Comando'
  WHEN LOWER(COALESCE(patente,'')) IN ('sub-comando','subcomando') THEN 'Sub-Comando'
  WHEN LOWER(COALESCE(patente,''))='supervisor' THEN 'Supervisor'
  WHEN LOWER(COALESCE(patente,''))='piloto oficial' THEN 'Piloto Oficial'
  ELSE 'Probatório' END
WHERE cargo IS NULL OR cargo='';

CREATE TABLE IF NOT EXISTS progressao_metas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL UNIQUE REFERENCES usuarios(id) ON DELETE CASCADE,
  efetivo_id UUID NOT NULL REFERENCES efetivo(id) ON DELETE CASCADE,
  carreira VARCHAR(20) NOT NULL DEFAULT 'probatorio',
  horas_meta NUMERIC(10,1) NOT NULL DEFAULT 20,
  pontos_meta NUMERIC(10,1) NOT NULL DEFAULT 15,
  qru_meta INT NOT NULL DEFAULT 5,
  acoes_meta INT NOT NULL DEFAULT 3,
  cursos_meta INT NOT NULL DEFAULT 0,
  observacoes TEXT,
  definido_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  definido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_progressao_metas_efetivo ON progressao_metas(efetivo_id);
CREATE INDEX IF NOT EXISTS idx_progressao_metas_carreira ON progressao_metas(carreira);

CREATE TABLE IF NOT EXISTS progressao_solicitacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  status VARCHAR(30) NOT NULL DEFAULT 'pendente',
  observacoes TEXT,
  decidido_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  decidido_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_progressao_solicitacoes_status ON progressao_solicitacoes(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_progressao_solicitacoes_pendente ON progressao_solicitacoes(usuario_id) WHERE status='pendente';
