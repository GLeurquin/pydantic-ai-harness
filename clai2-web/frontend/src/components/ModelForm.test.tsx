import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { RedactedProfile } from '../api/types';
import { toProfileEdit, type ModelFormState } from '../state/providers';
import { ModelForm } from './ModelForm';

function makeProfile(overrides: Partial<RedactedProfile> = {}): RedactedProfile {
  return {
    id: 'p1',
    label: 'Sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    hasApiKey: true,
    projectId: null,
    region: null,
    hasCredentials: false,
    extraEnv: [],
    ...overrides,
  };
}

describe('ModelForm', () => {
  it('renders the API key field and no vertex fields for anthropic', () => {
    render(<ModelForm onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText('API key')).toBeInTheDocument();
    expect(screen.queryByLabelText('Google Cloud project')).toBeNull();
    expect(screen.queryByLabelText('Region')).toBeNull();
    expect(screen.queryByLabelText('Service account JSON')).toBeNull();
  });

  it('renders the API key field for openai and google_gla', async () => {
    const user = userEvent.setup();
    render(<ModelForm onSave={vi.fn()} onCancel={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText('Provider'), 'openai');
    expect(screen.getByLabelText('API key')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Provider'), 'google_gla');
    expect(screen.getByLabelText('API key')).toBeInTheDocument();
  });

  it('renders the vertex fields and no API key field for google_vertex', async () => {
    const user = userEvent.setup();
    render(<ModelForm onSave={vi.fn()} onCancel={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText('Provider'), 'google_vertex');
    expect(screen.queryByLabelText('API key')).toBeNull();
    expect(screen.getByLabelText('Google Cloud project')).toBeInTheDocument();
    expect(screen.getByLabelText('Region')).toBeInTheDocument();
    expect(screen.getByLabelText('Service account JSON')).toBeInTheDocument();
  });

  it('renders neither API key nor vertex fields for bedrock and custom', async () => {
    const user = userEvent.setup();
    render(<ModelForm onSave={vi.fn()} onCancel={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText('Provider'), 'bedrock');
    expect(screen.queryByLabelText('API key')).toBeNull();
    expect(screen.queryByLabelText('Google Cloud project')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Provider'), 'custom');
    expect(screen.queryByLabelText('API key')).toBeNull();
    expect(screen.queryByLabelText('Google Cloud project')).toBeNull();
  });

  it('uses the provider-specific model placeholder', async () => {
    const user = userEvent.setup();
    render(<ModelForm onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText('Model')).toHaveAttribute('placeholder', 'claude-sonnet-4-6');
    await user.selectOptions(screen.getByLabelText('Provider'), 'custom');
    expect(screen.getByLabelText('Model')).toHaveAttribute('placeholder', 'provider:model-name');
  });

  it('switching provider swaps the API key field for the vertex fields', async () => {
    const user = userEvent.setup();
    render(<ModelForm onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText('API key')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Provider'), 'google_vertex');
    expect(screen.queryByLabelText('API key')).toBeNull();
    expect(screen.getByLabelText('Google Cloud project')).toBeInTheDocument();
  });

  it('shows the add label and empty placeholders when creating', () => {
    render(<ModelForm onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Add profile' })).toBeInTheDocument();
    expect(screen.getByLabelText('API key')).toHaveAttribute('placeholder', '');
  });

  it('seeds the form from a profile and shows unchanged placeholders with blank secret inputs', () => {
    render(<ModelForm profile={makeProfile({ label: 'Prod Sonnet' })} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText('Name')).toHaveValue('Prod Sonnet');
    expect(screen.getByLabelText('Model')).toHaveValue('claude-sonnet-4-6');
    const apiKey = screen.getByLabelText('API key');
    expect(apiKey).toHaveValue('');
    expect(apiKey).toHaveAttribute('placeholder', 'unchanged');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('edits the vertex project, region, and credentials fields', async () => {
    const user = userEvent.setup();
    render(<ModelForm onSave={vi.fn()} onCancel={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText('Provider'), 'google_vertex');
    await user.type(screen.getByLabelText('Google Cloud project'), 'my-project');
    await user.type(screen.getByLabelText('Region'), 'us-central1');
    await user.type(screen.getByLabelText('Service account JSON'), 'service-account-json');
    expect(screen.getByLabelText('Google Cloud project')).toHaveValue('my-project');
    expect(screen.getByLabelText('Region')).toHaveValue('us-central1');
    expect(screen.getByLabelText('Service account JSON')).toHaveValue('service-account-json');
  });

  it('shows the unchanged placeholder on the credentials field when editing a vertex profile', () => {
    render(
      <ModelForm
        profile={makeProfile({ provider: 'google_vertex', projectId: 'my-project', region: 'us-central1' })}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Google Cloud project')).toHaveValue('my-project');
    expect(screen.getByLabelText('Region')).toHaveValue('us-central1');
    expect(screen.getByLabelText('Service account JSON')).toHaveAttribute('placeholder', 'unchanged');
  });

  it('renders a secret env row with a password input and an unchanged placeholder', () => {
    render(
      <ModelForm
        profile={makeProfile({
          extraEnv: [
            { name: 'TOKEN', value: null, secret: true },
            { name: 'PROXY', value: 'http://proxy', secret: false },
          ],
        })}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const secretValue = screen.getByLabelText('env value 0');
    expect(secretValue).toHaveAttribute('type', 'password');
    expect(secretValue).toHaveAttribute('placeholder', 'unchanged');
    expect(secretValue).toHaveValue('');
    const plainValue = screen.getByLabelText('env value 1');
    expect(plainValue).toHaveAttribute('type', 'text');
    expect(plainValue).toHaveAttribute('placeholder', 'value');
    expect(plainValue).toHaveValue('http://proxy');
  });

  it('adds, edits, and removes environment variable rows', async () => {
    const user = userEvent.setup();
    render(<ModelForm onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText('env name 0')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add variable' }));
    await user.type(screen.getByLabelText('env name 0'), 'HTTP_PROXY');
    await user.type(screen.getByLabelText('env value 0'), 'http://proxy');
    expect(screen.getByLabelText('env value 0')).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByLabelText('env value 0')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('env name 0')).toHaveValue('HTTP_PROXY');
    await user.click(screen.getByRole('button', { name: 'remove env 0' }));
    expect(screen.queryByLabelText('env name 0')).toBeNull();
  });

  it('edits one env row without disturbing the others', async () => {
    const user = userEvent.setup();
    render(
      <ModelForm
        profile={makeProfile({
          extraEnv: [
            { name: 'FIRST', value: 'one', secret: false },
            { name: 'SECOND', value: 'two', secret: false },
          ],
        })}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await user.type(screen.getByLabelText('env name 0'), '_X');
    await user.type(screen.getByLabelText('env value 1'), '_Y');
    const [firstSecret] = screen.getAllByRole('checkbox');
    await user.click(firstSecret!);
    expect(screen.getByLabelText('env name 0')).toHaveValue('FIRST_X');
    expect(screen.getByLabelText('env name 1')).toHaveValue('SECOND');
    expect(screen.getByLabelText('env value 0')).toHaveValue('one');
    expect(screen.getByLabelText('env value 1')).toHaveValue('two_Y');
    expect(screen.getByLabelText('env value 0')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('env value 1')).toHaveAttribute('type', 'text');
  });

  it('shows a validation error and does not save when required fields are blank', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<(form: ModelFormState) => Promise<void>>().mockResolvedValue(undefined);
    render(<ModelForm onSave={onSave} onCancel={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Add profile' }));
    expect(screen.getByText('Give the profile a name.')).toHaveClass('form-error');
    expect(onSave).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Name'), 'Sonnet');
    await user.click(screen.getByRole('button', { name: 'Add profile' }));
    expect(screen.getByText('Enter a model.')).toHaveClass('form-error');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('calls onSave with a form that maps to the expected request body', async () => {
    const user = userEvent.setup();
    let captured: ModelFormState | undefined;
    const onSave = vi.fn<(form: ModelFormState) => Promise<void>>(async (form) => {
      captured = form;
    });
    render(<ModelForm onSave={onSave} onCancel={vi.fn()} />);
    await user.type(screen.getByLabelText('Name'), 'My Sonnet');
    await user.type(screen.getByLabelText('Model'), 'claude-sonnet-4-6');
    await user.type(screen.getByLabelText('API key'), 'sk-123');
    await user.click(screen.getByRole('button', { name: 'Add profile' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(captured).toBeDefined();
    expect(toProfileEdit(captured as ModelFormState)).toEqual({
      label: 'My Sonnet',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      extraEnv: [],
      apiKey: 'sk-123',
    });
  });

  it('shows the busy label while saving is pending', async () => {
    const user = userEvent.setup();
    let resolveSave!: () => void;
    const onSave = vi.fn<(form: ModelFormState) => Promise<void>>(
      () => new Promise<void>((res) => (resolveSave = res)),
    );
    render(<ModelForm onSave={onSave} onCancel={vi.fn()} />);
    await user.type(screen.getByLabelText('Name'), 'Sonnet');
    await user.type(screen.getByLabelText('Model'), 'm');
    await user.click(screen.getByRole('button', { name: 'Add profile' }));
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    resolveSave();
  });

  it('shows the error and re-enables the button when onSave rejects', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<(form: ModelFormState) => Promise<void>>().mockRejectedValue(new Error('model in use'));
    render(<ModelForm onSave={onSave} onCancel={vi.fn()} />);
    await user.type(screen.getByLabelText('Name'), 'Sonnet');
    await user.type(screen.getByLabelText('Model'), 'm');
    await user.click(screen.getByRole('button', { name: 'Add profile' }));
    expect(await screen.findByText('model in use')).toHaveClass('form-error');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add profile' })).toBeEnabled());
  });

  it('stringifies non-Error save failures', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<(form: ModelFormState) => Promise<void>>().mockRejectedValue('plain failure');
    render(<ModelForm onSave={onSave} onCancel={vi.fn()} />);
    await user.type(screen.getByLabelText('Name'), 'Sonnet');
    await user.type(screen.getByLabelText('Model'), 'm');
    await user.click(screen.getByRole('button', { name: 'Add profile' }));
    expect(await screen.findByText('plain failure')).toBeInTheDocument();
  });

  it('fires onCancel from the Cancel button', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<ModelForm onSave={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
