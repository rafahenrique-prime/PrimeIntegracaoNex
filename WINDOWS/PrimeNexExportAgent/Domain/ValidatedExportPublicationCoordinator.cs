using PrimeNexExportAgent.Contracts;

namespace PrimeNexExportAgent.Domain;

/// <summary>
/// Coordenador MINIMO (F6.14B2.11B) - a UNICA regra que conhece e' a
/// ORDEM: validar antes de publicar. Nunca sabe sobre Node, JSON,
/// cabecalhos XLS, File.Move, regras de volume/colisao - tudo isso
/// permanece encapsulado em IExportValidator/IAtomicPublisher, cada um
/// responsavel pela sua propria decisao.
///
/// NAO conectado a ExportAgentOrchestrator nesta fase (F6.14B2.11B secao
/// 11) - uma execucao comum do Agent NUNCA passa por aqui ainda. So
/// alcancavel a partir de codigo de teste/uma futura orquestracao
/// explicita, nunca a partir de um probe operacional nesta tarefa.
/// </summary>
public sealed class ValidatedExportPublicationCoordinator
{
    private readonly IExportValidator _validator;
    private readonly IAtomicPublisher _publisher;

    public ValidatedExportPublicationCoordinator(IExportValidator validator, IAtomicPublisher publisher)
    {
        _validator = validator;
        _publisher = publisher;
    }

    /// <summary>
    /// EXATAMENTE 1 chamada a Validate(); Publish() so e' chamado (no
    /// maximo 1 vez) se Validate() aprovar. Zero retry em qualquer dos
    /// dois, em qualquer ramo.
    /// </summary>
    public ValidatedPublicationResult Execute(string sourcePath, string destinationDirectory)
    {
        var validation = _validator.Validate(sourcePath);
        if (!validation.Valid)
        {
            return ValidatedPublicationResult.ValidationRejected(validation);
        }

        var publication = _publisher.Publish(sourcePath, destinationDirectory);
        if (!publication.Published)
        {
            return ValidatedPublicationResult.PublicationRejected(validation, publication);
        }

        return ValidatedPublicationResult.Succeeded(validation, publication);
    }
}
